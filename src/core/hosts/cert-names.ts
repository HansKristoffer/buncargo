import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineListRegistry } from "../registry-file";
import { chownToInvokingUser, getHostsStateDir } from "./paths";

/**
 * The certificate names each project wants, remembered across runs.
 *
 * One leaf serves every project on the machine, and it used to be minted from
 * whatever was in the route registry at that moment. So a project stopping
 * dropped its names, and starting it again reminted — which rebinds the daemon
 * and drops every proxied websocket, including other projects' HMR sockets.
 * Two projects alternating could remint on every single run.
 *
 * Keyed by repo root, which is also how an entry is retired: a worktree that
 * has been deleted is gone from disk, and its names go with it. That is the
 * one signal available — a route disappears whenever a run ends, and cannot
 * distinguish "stopped" from "removed".
 */

const REGISTRY_VERSION = 1;

/**
 * How many roots to remember.
 *
 * Generous: entries are small and are already pruned by directory existence.
 * The cap only bounds a machine that creates and deletes checkouts faster than
 * anything reads this file.
 */
const MAX_ROOTS = 200;

export interface CertNameEntry {
	/** Repo root the names belong to. */
	root: string;
	/** Hostnames and wildcards, as `certificateHostnames` produced them. */
	names: string[];
	updatedAt: string;
}

export const CERT_NAMES_FILENAME = "cert-names.json";

export function getCertNamesPath(): string {
	return join(getHostsStateDir(), CERT_NAMES_FILENAME);
}

function isCertNameEntry(value: unknown): value is CertNameEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<CertNameEntry>;
	return (
		typeof entry.root === "string" &&
		Array.isArray(entry.names) &&
		entry.names.every((name) => typeof name === "string") &&
		typeof entry.updatedAt === "string"
	);
}

const registry = defineListRegistry<CertNameEntry>({
	version: REGISTRY_VERSION,
	key: "projects",
	isEntry: isCertNameEntry,
	afterWrite: chownToInvokingUser,
});

function byNewestFirst(a: CertNameEntry, b: CertNameEntry): number {
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/**
 * Drop entries whose checkout is gone, and cap what is left.
 *
 * Exported for the test, and pure so the "is it still there" check can be
 * substituted.
 */
export function pruneCertNameEntries(
	entries: CertNameEntry[],
	rootExists: (root: string) => boolean = existsSync,
): CertNameEntry[] {
	return entries
		.filter((entry) => rootExists(entry.root))
		.sort(byNewestFirst)
		.slice(0, MAX_ROOTS);
}

/**
 * Record this project's names and return every name the certificate should
 * carry, across all projects still on disk.
 *
 * Callers hold the certificate lock, so this does not take one of its own.
 */
export async function rememberCertNames(input: {
	root?: string;
	names: string[];
	path?: string;
	rootExists?: (root: string) => boolean;
}): Promise<string[]> {
	const path = input.path ?? getCertNamesPath();
	const stored = await registry.read(path);
	const live = pruneCertNameEntries(stored, input.rootExists);

	// An empty name list is never a recording: a caller that only wants the
	// union must not be able to erase a project's coverage by omission.
	// Retiring an entry goes through `forgetCertNames`.
	const next =
		input.root && input.names.length > 0
			? [
					...live.filter((entry) => entry.root !== input.root),
					{
						root: input.root,
						names: [...new Set(input.names)].sort(),
						updatedAt: new Date().toISOString(),
					},
				]
			: live;

	// Only when something actually changed: this runs on every dev start, and
	// the daemon watches this directory.
	if (JSON.stringify(next) !== JSON.stringify(stored)) {
		await registry.write(path, next);
	}

	return [...new Set(next.flatMap((entry) => entry.names))].sort();
}

/** Every remembered name, without recording anything. */
export async function readCertNames(
	path = getCertNamesPath(),
): Promise<string[]> {
	const entries = pruneCertNameEntries(await registry.read(path));
	return [...new Set(entries.flatMap((entry) => entry.names))].sort();
}

/** Forget one project, for `hosts uninstall` and teardown paths. */
export async function forgetCertNames(
	root: string,
	path = getCertNamesPath(),
): Promise<void> {
	const stored = await registry.read(path);
	const next = stored.filter((entry) => entry.root !== root);
	if (next.length !== stored.length) await registry.write(path, next);
}
