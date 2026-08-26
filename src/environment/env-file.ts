/**
 * Keep a repo's dotenv pointing at the ports buncargo actually bound.
 *
 * buncargo injects the right values into the processes it spawns, but `bun test`,
 * an ad-hoc `bun run`, Playwright and GUI clients read `.env` from disk. The port
 * offset is a hash of the project name and shifts again per worktree, so a
 * hand-written `localhost:5432` is stale by construction.
 *
 * The file stays the repo's contract: this only ever rewrites the value of a key
 * that is already there, and only when that value looks like something buncargo
 * owns. A deliberate override - a cloned remote database, a shared staging
 * service - survives untouched.
 */

import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { buildSharedEnvValues } from "../core/env";
import type { PortMap, UrlMap } from "../core/ports";
import type { EnvFileOptions, ServiceConfig } from "../types";

/** `.env` line: optional `export`, a key, `=`, then the value. */
const ENV_LINE =
	/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*?)(\r?\n?)$/;

/**
 * Whether buncargo may overwrite this value.
 *
 * True for unset, a bare port number, or an address already on loopback -
 * everything else is someone's deliberate choice.
 */
export function isReplaceableEnvValue(value: string): boolean {
	const trimmed = value.trim().replace(/^["']|["']$/g, "");
	if (trimmed === "") return true;
	if (/^\d+$/.test(trimmed)) return true;

	const host = trimmed.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^:/?]+)/i)?.[1];
	return host === "localhost" || host === "127.0.0.1";
}

export interface EnvFileRewrite {
	contents: string;
	/** Keys whose value this changed. */
	changed: string[];
}

/**
 * Replace the value of each key in `updates`, preserving comments, ordering and
 * every other byte.
 */
export function rewriteEnvValues(
	contents: string,
	updates: Readonly<Record<string, string | undefined>>,
): EnvFileRewrite {
	const changed: string[] = [];

	// Split after each newline so the terminator stays attached to its line and
	// a file with no trailing newline round-trips unchanged.
	const next = contents
		.split(/(?<=\n)/)
		.map((line) => {
			const match = line.match(ENV_LINE);
			if (!match) return line;

			const [, prefix, key, separator, value, newline] = match;
			if (key === undefined) return line;

			const replacement = updates[key];
			if (
				replacement === undefined ||
				replacement === value ||
				!isReplaceableEnvValue(value ?? "")
			) {
				return line;
			}

			changed.push(key);
			return `${prefix}${key}${separator}${replacement}${newline}`;
		})
		.join("");

	return { contents: next, changed };
}

/**
 * The values a dotenv may adopt, keyed exactly as the injected environment.
 *
 * Built from the *loopback* URLs, never the named `https://` hosts: the whole
 * reason to write this file is tooling that cannot use the local CA.
 */
export function buildEnvFileUpdates(input: {
	projectName: string;
	services: Record<string, ServiceConfig>;
	ports: PortMap;
	loopbackUrls: UrlMap;
	values?: EnvFileOptions["values"];
}): Record<string, string> {
	const shared = buildSharedEnvValues({
		projectName: input.projectName,
		services: input.services,
		ports: input.ports,
		// Deliberately the loopback map in the `urls` slot, so `<NAME>_URL` and
		// the service aliases (`DATABASE_URL`, ...) land on localhost.
		urls: input.loopbackUrls,
		loopbackUrls: input.loopbackUrls,
		publicUrls: {},
	});

	const updates: Record<string, string> = {};
	for (const [key, value] of Object.entries(shared)) {
		if (value !== undefined) updates[key] = String(value);
	}
	// Last, so a repo can correct a computed value rather than only add to it.
	for (const [key, value] of Object.entries(
		input.values?.(input.ports, input.loopbackUrls) ?? {},
	)) {
		if (value !== undefined) updates[key] = String(value);
	}
	return updates;
}

/** Normalize `boolean | EnvFileOptions` to the options, or undefined when off. */
export function resolveEnvFileOptions(
	envFile: boolean | EnvFileOptions | undefined,
): (Required<Pick<EnvFileOptions, "path">> & EnvFileOptions) | undefined {
	if (!envFile) return undefined;
	const options = envFile === true ? {} : envFile;
	return { ...options, path: options.path ?? ".env" };
}

export interface EnvFileSyncResult {
	/** Absolute path of the file considered. */
	path: string;
	/** Keys whose value changed. */
	changed: string[];
	/** Whether the file was bootstrapped from `createFrom`. */
	created: boolean;
	/** Set when nothing was written because there is no file to update. */
	absent?: boolean;
}

function tempPathFor(path: string): string {
	return `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sync one dotenv in place.
 *
 * Writes through a temp file and a rename so a concurrent reader - a test
 * runner loading `.env` while this runs - never sees a truncated file.
 */
export async function syncEnvFile(input: {
	root: string;
	envFile: boolean | EnvFileOptions | undefined;
	projectName: string;
	services: Record<string, ServiceConfig>;
	ports: PortMap;
	loopbackUrls: UrlMap;
}): Promise<EnvFileSyncResult | undefined> {
	const options = resolveEnvFileOptions(input.envFile);
	if (!options) return undefined;

	const path = isAbsolute(options.path)
		? options.path
		: resolve(input.root, options.path);

	let contents: string;
	let created = false;
	try {
		contents = await readFile(path, "utf-8");
	} catch {
		if (!options.createFrom) {
			// Never conjure a dotenv the repo did not ask for.
			return { path, changed: [], created: false, absent: true };
		}
		const template = isAbsolute(options.createFrom)
			? options.createFrom
			: resolve(input.root, options.createFrom);
		try {
			await copyFile(template, path);
			contents = await readFile(path, "utf-8");
			created = true;
		} catch {
			return { path, changed: [], created: false, absent: true };
		}
	}

	const { contents: next, changed } = rewriteEnvValues(
		contents,
		buildEnvFileUpdates({
			projectName: input.projectName,
			services: input.services,
			ports: input.ports,
			loopbackUrls: input.loopbackUrls,
			values: options.values,
		}),
	);

	if (changed.length === 0 && !created) {
		return { path, changed, created };
	}

	const temp = tempPathFor(path);
	try {
		await writeFile(temp, next, "utf-8");
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}

	return { path, changed, created };
}
