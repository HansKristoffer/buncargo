import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describeExpoApp } from "../core/expo";
import { readProcessIdentity } from "../core/process-identity";
import {
	buildRunEntry,
	patchRun,
	publishRun,
	type RunAppEntry,
	type RunAppStatus,
	type RunEntry,
	type RunPatch,
	type RunServiceEntry,
	type RunServiceStatus,
} from "../core/run-registry";
import { describeService } from "../core/service-identity";
import { defaultServiceProtocol } from "../core/service-presets";
import type {
	AppConfig,
	ContainerRuntimeName,
	NamedHost,
	ServiceConfig,
} from "../types";
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
	/** The session the environment already claimed its containers under. */
	readonly sessionId: string;
	readonly containerRuntime?: ContainerRuntimeName;
	readonly containerRuntimeBinary?: string;
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
		const stat = statSync(gitPath).isFile()
			? readFileSync(gitPath, "utf-8")
			: "";
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
		if (port === undefined && input.apps[name]?.kind !== "worker") return [];
		const loopbackUrl =
			port === undefined
				? undefined
				: (loopbackUrls[name] ?? `http://localhost:${port}`);
		return [
			{
				name,
				kind: input.apps[name]?.kind,
				protocol: input.apps[name]?.exposeProtocol ?? "http",
				port,
				attached: input.attached === name ? true : undefined,
				url: urls[name] ?? loopbackUrl,
				loopbackUrl,
				publicUrl: publicUrls[name],
				hostname: hostnameFor.get(name),
				expo: describeExpoApp(env.root, input.apps[name]),
				status: input.statusFor(name),
			},
		];
	});
}

function serviceEntries(
	env: RunSource,
	status: RunServiceStatus,
	serviceNames?: readonly string[],
): RunServiceEntry[] {
	const ports = env.ports as Record<string, number>;
	const urls = env.urls as Record<string, string>;
	const loopbackUrls = env.loopbackUrls as Record<string, string>;
	const publicUrls = env.publicUrls as Record<string, string>;
	const hostnameFor = new Map(
		(env.hosts?.plan ?? []).map((entry) => [entry.name, entry.hostname]),
	);

	return Object.entries(env.services)
		.filter(([name]) => !serviceNames || serviceNames.includes(name))
		.flatMap(([name, service]) => {
			const port = ports[name];

			const identity =
				port === undefined
					? { preset: undefined, tablePlusUrl: undefined }
					: describeService({
							name,
							service,
							port,
							projectName: env.projectName,
						});
			const loopbackUrl =
				port === undefined
					? undefined
					: (loopbackUrls[name] ?? `http://localhost:${port}`);
			return [
				{
					name,
					kind: service.kind,
					preset: identity.preset,
					protocol:
						service.exposeProtocol ?? defaultServiceProtocol(identity.preset),
					container: env.containerRuntime
						? {
								runtime: env.containerRuntime,
								binary: env.containerRuntimeBinary,
								service: service.serviceName ?? name,
								name: `${env.projectName}-${service.serviceName ?? name}`,
							}
						: undefined,
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
	serviceNames?: readonly string[];
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
	// The environment claimed under this session before starting containers,
	// so this publishes over that claim rather than beside it.
	const entry: RunEntry = {
		...buildRunEntry({
			sessionId: env.sessionId,
			projectPrefix: env.projectPrefix,
			projectName: env.projectName,
			root: env.root,
			isWorktree: env.isWorktree,
		}),
		branch: readGitBranch(env.root),
		primaryApp: env.resolvePrimaryApp(Object.keys(input.apps)),
		hosts: env.hosts ? { active: env.hosts.active, tld: env.hosts.tld } : null,
		apps: appEntries(env, {
			apps: input.apps,
			attached: input.attached,
			statusFor: (name) => (reused.has(name) ? "reused" : "starting"),
		}),
		services: serviceEntries(
			env,
			input.serviceStatus ?? "ready",
			input.serviceNames,
		),
	};

	await publishRun(entry);
	return entry;
}

/** The part of an environment a patch needs: which session to write to. */
export interface RunSession {
	readonly sessionId: string;
}

const pendingPatches = new Map<string, Promise<void>>();

/**
 * Serialize one session's patches, so a slow write cannot land after a later
 * one and put an app back to an older state.
 */
function enqueue(
	sessionId: string,
	operation: () => Promise<void>,
): Promise<void> {
	const previous = pendingPatches.get(sessionId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(operation);
	pendingPatches.set(sessionId, next);
	void next
		.finally(() => {
			if (pendingPatches.get(sessionId) === next)
				pendingPatches.delete(sessionId);
		})
		.catch(() => {});
	return next;
}

export async function patchCurrentRun(
	run: RunSession,
	patch: RunPatch,
): Promise<void> {
	try {
		await enqueue(run.sessionId, () => patchRun(run.sessionId, patch));
	} catch (error) {
		reportFailure("update", error);
	}
}

/** Mark every named app with one status, e.g. all of wave 1 becoming `ready`. */
export async function markApps(
	run: RunSession,
	names: readonly string[],
	status: RunAppStatus,
): Promise<void> {
	if (names.length === 0) return;
	await patchCurrentRun(run, {
		apps: names.map((name) => ({ name, status })),
	});
}

/**
 * Record a spawned app's pid together with its birth identity.
 *
 * `stop` refuses to signal an app whose entry has no identity, since a bare
 * pid may by then belong to something else. The spawner used to record the
 * pid alone, so the menu bar's Stop refused every app it was asked to stop.
 */
export async function recordAppSpawn(
	run: RunSession,
	name: string,
	pid: number,
	attached: boolean,
): Promise<void> {
	await patchCurrentRun(run, {
		apps: [
			{
				name,
				pid,
				processIdentity: readProcessIdentity(pid),
				attached: attached || undefined,
			},
		],
	});
}
