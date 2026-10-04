import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appEntryPath, preferredAppUrl } from "../core/app-url";
import type { CapturedValue } from "../core/process/output-capture";
import { readProcessIdentitiesAsync } from "../core/process-identity";
import {
	buildRunEntryAsync,
	findRunsByRoot,
	patchRunBatch,
	publishRun,
	type RunAppEntry,
	type RunAppStatus,
	type RunDetailEntry,
	type RunEntry,
	type RunPatch,
	type RunServiceEntry,
	type RunServiceStatus,
} from "../core/run-registry";
import { describeService } from "../core/service-identity";
import { defaultServiceProtocol } from "../core/service-presets";
import type {
	AppConfig,
	BuncargoIntegration,
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
	/** Integrations add their own fields to each app's entry (`expo`, …). */
	readonly integrations?: readonly BuncargoIntegration[];
	readonly workspaceId?: string;
	details?(): Record<string, string>;
	readonly tasks?: Readonly<Record<string, { readonly description?: string }>>;
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

/** The run's labelled values, as registry rows; best-effort like the rest. */
function runDetails(env: Pick<RunSource, "details">): {
	details?: RunDetailEntry[];
} {
	try {
		const values = env.details?.() ?? {};
		const details = Object.entries(values).map(([label, value]) => ({
			label,
			value,
		}));
		return details.length > 0 ? { details } : {};
	} catch {
		return {};
	}
}

/** What each integration records about one app, merged in integration order. */
function integrationFields(
	env: RunSource,
	name: string,
	config: AppConfig | undefined,
	port: number | undefined,
): Record<string, unknown> {
	if (!config) return {};
	const fields: Record<string, unknown> = {};
	for (const integration of env.integrations ?? []) {
		Object.assign(
			fields,
			integration.describeApp?.({
				name,
				config,
				port,
				root: env.root,
				workspaceId: env.workspaceId ?? "",
			}),
		);
	}
	return fields;
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
				openUrl: preferredAppUrl(
					{
						url: urls[name] ?? loopbackUrl,
						loopbackUrl,
						publicUrl: publicUrls[name],
						entryPath: input.apps[name]?.entryPath,
					},
					env.hosts?.active ?? false,
				),
				hostname: hostnameFor.get(name),
				...integrationFields(env, name, input.apps[name], port),
				exclusive: input.apps[name]?.exclusive,
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
					stack: service.external?.stack,
					container:
						env.containerRuntime && !service.external
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
		...(await buildRunEntryAsync({
			sessionId: env.sessionId,
			projectPrefix: env.projectPrefix,
			projectName: env.projectName,
			root: env.root,
			isWorktree: env.isWorktree,
		})),
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
		...runDetails(env),
		...(env.tasks && Object.keys(env.tasks).length > 0
			? {
					tasks: Object.entries(env.tasks).map(([name, task]) => ({
						name,
						...(task.description ? { description: task.description } : {}),
					})),
				}
			: {}),
	};

	await publishRun(entry);
	return entry;
}

/** The part of an environment a patch needs: which session to write to. */
export interface RunSession {
	readonly sessionId: string;
}

interface PendingPatch {
	patch: RunPatch;
	identify: boolean;
	resolve(): void;
}
interface PatchQueue {
	pending: PendingPatch[];
	running: Promise<void>;
}
const pendingPatches = new Map<string, PatchQueue>();

/** Coalesce one turn's spawn/status events; later batches stay ordered. */
function enqueue(
	sessionId: string,
	patch: RunPatch,
	identify = false,
): Promise<void> {
	let queue = pendingPatches.get(sessionId);
	if (!queue) {
		queue = { pending: [], running: Promise.resolve() };
		pendingPatches.set(sessionId, queue);
		const current = queue;
		current.running = new Promise<void>((resolve) =>
			setImmediate(resolve),
		).then(async () => {
			try {
				while (current.pending.length > 0) {
					const batch = current.pending.splice(0);
					try {
						const identities = await readProcessIdentitiesAsync(
							batch.flatMap((item) =>
								item.identify
									? (item.patch.apps?.flatMap((app) =>
											app.pid === undefined ? [] : [app.pid],
										) ?? [])
									: [],
							),
						);
						for (const item of batch)
							if (item.identify)
								for (const app of item.patch.apps ?? [])
									if (app.pid !== undefined)
										app.processIdentity = identities.get(app.pid);
						await patchRunBatch(
							sessionId,
							batch.map((item) => item.patch),
						);
					} catch (error) {
						reportFailure("update", error);
					} finally {
						for (const item of batch) item.resolve();
					}
				}
			} finally {
				pendingPatches.delete(sessionId);
			}
		});
	}
	return new Promise((resolve) =>
		queue?.pending.push({ patch, identify, resolve }),
	);
}

/** Wait for observational writes before ending the session. Claims remain immediate. */
export async function flushRunPatches(run: RunSession): Promise<void> {
	await pendingPatches.get(run.sessionId)?.running;
}

export async function patchCurrentRun(
	run: RunSession,
	patch: RunPatch,
): Promise<void> {
	await enqueue(run.sessionId, patch);
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
	await enqueue(
		run.sessionId,
		{
			apps: [
				{
					name,
					pid,
					attached: attached || undefined,
				},
			],
		},
		true,
	);
}

/**
 * Record each app's public URL and what "open" now means for it, once
 * tunnels have opened: the run was published before they had URLs, so
 * BuncargoBar would otherwise keep opening loopback.
 */
export async function recordAppUrls(
	env: RunSession &
		Pick<RunSource, "urls" | "loopbackUrls" | "publicUrls" | "hosts"> & {
			readonly apps?: object;
		},
	names: readonly string[],
): Promise<void> {
	const read = (urls: object, name: string) =>
		(urls as Record<string, string | undefined>)[name];
	const apps = names.flatMap((name) => {
		const publicUrl = read(env.publicUrls, name);
		if (!publicUrl) return [];
		const openUrl = preferredAppUrl(
			{
				url: read(env.urls, name),
				loopbackUrl: read(env.loopbackUrls, name),
				publicUrl,
				entryPath: appEntryPath(read(env.apps ?? {}, name)),
			},
			env.hosts?.active ?? false,
		);
		return [{ name, publicUrl, openUrl }];
	});
	if (apps.length > 0) await patchCurrentRun(env, { apps });
}

/**
 * Record a captured value: in `captures`, and as the app's `publicUrl` when
 * it is one, so BuncargoBar shows the preview URL like a tunnel's. Refreshes
 * the labelled rows too, since those are mostly captures.
 */
export async function recordRunCapture(
	env: RunSession & Pick<RunSource, "details">,
	app: string,
	captured: CapturedValue,
): Promise<void> {
	const { details } = runDetails(env);
	await patchCurrentRun(env, {
		...(captured.as === "event"
			? {}
			: { captures: { [captured.name]: captured.value } }),
		...(captured.as === "publicUrl"
			? {
					apps: [
						{ name: app, publicUrl: captured.value, openUrl: captured.value },
					],
				}
			: {}),
		...(details ? { details } : {}),
	});
}

/**
 * Adopt the captures of this checkout's live run, for a command in another
 * process (`env`, `generate`, `wait`) that should see what `dev` captured.
 * Returns them; the newest run wins when several are live.
 */
export async function adoptLiveCaptures(env: {
	root: string;
	captured: Readonly<Record<string, string>>;
	setPublicUrls?(urls: Record<string, string>): void;
}): Promise<Record<string, string>> {
	try {
		const runs = (await findRunsByRoot(env.root)).sort((a, b) =>
			a.startedAt.localeCompare(b.startedAt),
		);
		const captures: Record<string, string> = Object.assign(
			{},
			...runs.map((run) => run.captures ?? {}),
		);
		Object.assign(env.captured as Record<string, string>, captures);
		// Captured and tunnel public URLs alike, as the run published them.
		env.setPublicUrls?.(
			Object.fromEntries(
				runs.flatMap((run) =>
					run.apps.flatMap((app) =>
						app.publicUrl ? [[app.name, app.publicUrl] as const] : [],
					),
				),
			),
		);
		return captures;
	} catch {
		return {};
	}
}
