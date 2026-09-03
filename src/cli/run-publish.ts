import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getWorktreeName } from "../core/ports";
import {
	patchRun,
	publishRun,
	type RunAppEntry,
	type RunAppStatus,
	type RunEntry,
	type RunPatch,
	type RunServiceEntry,
	type RunServiceStatus,
	withdrawRun,
} from "../core/run-registry";
import { describeService } from "../core/service-identity";
import type { AppConfig, NamedHost, ServiceConfig } from "../types";
import * as log from "./log";

/**
 * Publishing a `buncargo dev` into the run registry.
 *
 * CLI-side on purpose: the entry records this *process* — its pid, the
 * interpreter that started it, the apps this invocation chose to spawn — none
 * of which the environment object knows. `createDevEnvironment` is also a
 * library API that a test or a script may build without any of this being true.
 *
 * Every function here swallows its own failures. The registry is what powers
 * `runs`, `stop` and the menu bar; none of them is worth failing a dev run
 * over, and a run that started servers but could not write a status file is
 * still a working dev environment.
 */

/**
 * The part of a `DevEnvironment` a run entry is built from.
 *
 * Structural rather than `DevEnvironment<...>` with its keys widened: the
 * environment's app/service key positions appear in both parameter and return
 * types, so a widened version of it is not a supertype of a specific one. This
 * lists what is read and nothing else.
 */
export interface RunSource {
	readonly projectPrefix: string;
	readonly projectName: string;
	readonly root: string;
	readonly isWorktree: boolean;
	readonly ports: object;
	readonly urls: object;
	readonly loopbackUrls: object;
	readonly publicUrls: object;
	readonly services: Record<string, ServiceConfig>;
	readonly hosts: {
		readonly active: boolean;
		readonly tld: string;
		readonly plan: readonly NamedHost[];
	} | null;
	resolvePrimaryApp(selected?: readonly string[]): string | undefined;
}

function reportFailure(action: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	log.warn(`Could not ${action} the run registry: ${message}`);
}

/**
 * The branch a checkout is on, for the menu bar's row subtitle.
 *
 * Read here rather than in the app, so nothing downstream has to know that a
 * worktree's `.git` is a file pointing at the real git directory. A detached
 * HEAD or an unreadable file yields nothing, which the UI renders as no
 * subtitle at all.
 */
export function readGitBranch(root: string): string | undefined {
	try {
		const gitPath = join(root, ".git");
		if (!existsSync(gitPath)) return undefined;
		const stat = readFileSync(gitPath, "utf-8");
		const gitDir = stat.startsWith("gitdir:")
			? resolve(dirname(gitPath), stat.slice("gitdir:".length).trim())
			: gitPath;
		const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
		const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * How to run this same buncargo again.
 *
 * `process.argv[1]` is the CLI entry that is executing right now, so a reader
 * gets the build that owns the run rather than whatever `buncargo` resolves to
 * in its own environment — routinely a different version in a worktree.
 */
function currentCli(): RunEntry["cli"] {
	return { program: process.execPath, script: process.argv[1] };
}

function appEntries(
	env: RunSource,
	input: {
		apps: Record<string, AppConfig>;
		statusFor: (name: string) => RunAppStatus;
		attached?: string;
	},
): RunAppEntry[] {
	const ports = env.ports as Record<string, number>;
	const urls = env.urls as Record<string, string>;
	const loopbackUrls = env.loopbackUrls as Record<string, string>;
	const publicUrls = env.publicUrls as Record<string, string>;
	const hostnameFor = new Map(
		(env.hosts?.plan ?? []).map((entry) => [entry.name, entry.hostname]),
	);

	return Object.keys(input.apps).flatMap((name) => {
		const port = ports[name];
		if (port === undefined) return [];
		const loopbackUrl = loopbackUrls[name] ?? `http://localhost:${port}`;
		return [
			{
				name,
				port,
				attached: input.attached === name ? true : undefined,
				url: urls[name] ?? loopbackUrl,
				loopbackUrl,
				publicUrl: publicUrls[name],
				hostname: hostnameFor.get(name),
				status: input.statusFor(name),
			},
		];
	});
}

function serviceEntries(
	env: RunSource,
	status: RunServiceStatus,
): RunServiceEntry[] {
	const ports = env.ports as Record<string, number>;
	const urls = env.urls as Record<string, string>;
	const loopbackUrls = env.loopbackUrls as Record<string, string>;
	const publicUrls = env.publicUrls as Record<string, string>;
	const hostnameFor = new Map(
		(env.hosts?.plan ?? []).map((entry) => [entry.name, entry.hostname]),
	);

	return Object.entries(env.services).flatMap(([name, service]) => {
		const port = ports[name];
		if (port === undefined) return [];
		const identity = describeService({
			name,
			service,
			port,
			projectName: env.projectName,
		});
		const loopbackUrl = loopbackUrls[name] ?? `http://localhost:${port}`;
		return [
			{
				name,
				preset: identity.preset,
				port,
				url: urls[name] ?? loopbackUrl,
				loopbackUrl,
				publicUrl: publicUrls[name],
				hostname: hostnameFor.get(name),
				tablePlusUrl: identity.tablePlusUrl,
				status,
			},
		];
	});
}

export interface PublishRunInput {
	/** Apps this run is responsible for, spawned or reused. */
	apps: Record<string, AppConfig>;
	/** Apps served by someone else, so this run cannot stop them. */
	reusedNames?: readonly string[];
	attached?: string;
	/**
	 * Defaults to `ready`: a run publishes itself after `env.start({ wait: true })`
	 * has waited for every container, so by then they are up by construction.
	 */
	serviceStatus?: RunServiceStatus;
}

/** Write this run into the registry. Returns the entry, or `undefined` on failure. */
export async function publishCurrentRun(
	env: RunSource,
	input: PublishRunInput,
): Promise<RunEntry | undefined> {
	try {
		return await writeRun(env, input);
	} catch (error) {
		reportFailure("write", error);
		return undefined;
	}
}

/**
 * Build and store the entry.
 *
 * Split out so {@link publishCurrentRun} can wrap *construction* too: reading
 * URLs and git state off a half-built environment is as capable of throwing as
 * the write is, and neither may take a dev run down.
 */
async function writeRun(
	env: RunSource,
	input: PublishRunInput,
): Promise<RunEntry> {
	const reused = new Set(input.reusedNames ?? []);
	const now = new Date().toISOString();
	const entry: RunEntry = {
		projectPrefix: env.projectPrefix,
		projectName: env.projectName,
		root: env.root,
		worktree: env.isWorktree
			? (getWorktreeName(env.root) ?? basename(env.root))
			: null,
		branch: readGitBranch(env.root),
		pid: process.pid,
		startedAt: now,
		updatedAt: now,
		primaryApp: env.resolvePrimaryApp(Object.keys(input.apps)),
		hosts: env.hosts ? { active: env.hosts.active, tld: env.hosts.tld } : null,
		cli: currentCli(),
		apps: appEntries(env, {
			apps: input.apps,
			attached: input.attached,
			statusFor: (name) => (reused.has(name) ? "reused" : "starting"),
		}),
		services: serviceEntries(env, input.serviceStatus ?? "ready"),
	};

	await publishRun(entry);
	return entry;
}

export async function patchCurrentRun(
	root: string,
	patch: RunPatch,
): Promise<void> {
	try {
		await patchRun(root, process.pid, patch);
	} catch (error) {
		reportFailure("update", error);
	}
}

export async function withdrawCurrentRun(root: string): Promise<void> {
	try {
		await withdrawRun(root, process.pid);
	} catch (error) {
		reportFailure("clear", error);
	}
}

/** Mark every named app with one status, e.g. all of wave 1 becoming `ready`. */
export async function markApps(
	root: string,
	names: readonly string[],
	status: RunAppStatus,
): Promise<void> {
	if (names.length === 0) return;
	await patchCurrentRun(root, {
		apps: names.map((name) => ({ name, status })),
	});
}

/** Attach the pids the spawner handed back, so `stop` can signal one app. */
export async function recordAppPids(
	root: string,
	pids: Record<string, number>,
): Promise<void> {
	const entries = Object.entries(pids);
	if (entries.length === 0) return;
	await patchCurrentRun(root, {
		apps: entries.map(([name, pid]) => ({ name, pid })),
	});
}
