import { statSync } from "node:fs";
import { isBoolean, isOneOf, isRecord, isString } from "hanzio";
import {
	arrayOf,
	type Guarded,
	isFiniteNumber,
	isPort,
	isPositiveInteger,
	nullable,
	object,
	oneOf,
	optional,
	recordOf,
	refine,
} from "./json-shape";
import { isProcessAlive } from "./process/lifecycle";
import { readProcessIdentitiesCached } from "./process-identity-sync";
import { defineListRegistry } from "./registry-file";
import { stateFilePath } from "./state-paths";

/**
 * Synchronous, read-only schema and liveness reader for `~/.buncargo/runs.json`.
 *
 * Kept separate from `run-registry.ts`'s writers, locks, and async `ps` runner
 * so config-authoring imports (`buncargo` / `lookupRunningApp`) never pull
 * process execution, termination, file locking, or styling into `dev.config.ts`.
 * `run-registry.ts` re-exports everything here as the single public owner.
 */

/**
 * The `runs.json` schema. Bumping it makes every older BuncargoBar unable to
 * read the file, which is why `core/menubar.ts` compares it against the
 * installed bundle's `BuncargoRegistryVersion` and updates the app.
 */
export const REGISTRY_VERSION = 2;
const RUNS_FILENAME = "runs.json";

const isProtocol = isOneOf(["http", "tcp"]);

/** An endpoint has a port and both URLs, or none of the three. */
function endpointComplete(row: {
	port?: number;
	url?: string;
	loopbackUrl?: string;
}): boolean {
	const fields = [row.port, row.url, row.loopbackUrl];
	return (
		fields.every((field) => field === undefined) ||
		fields.every((field) => field !== undefined)
	);
}

const isRunApp = refine(
	object({
		/** Transport used when sharing this endpoint through frp. */
		protocol: optional(isProtocol),
		kind: optional(isOneOf(["server", "worker"])),
		name: isString,
		port: optional(isPort),
		/** The spawned dev server. Absent when the app was reused from another run. */
		pid: optional(isPositiveInteger),
		processIdentity: optional(isString),
		/** Holds the TTY; stopping it tears the whole run down. */
		attached: optional(isBoolean),
		url: optional(isString),
		loopbackUrl: optional(isString),
		publicUrl: optional(isString),
		/**
		 * The URL of the tunnel that reaches this app, opened by this run or
		 * inherited from the run it reuses the app from. A `publicUrl` can
		 * also be one the app printed (`captures`); only this is another
		 * run's to inherit.
		 */
		tunnelUrl: optional(isString),
		/** What "open" opens for this app (`preferredAppUrl`), so every reader agrees. */
		openUrl: optional(isString),
		hostname: optional(isString),
		/**
		 * What each integration's `describeApp` recorded, by integration name
		 * (`integrations.expo` is what `buncargo expo sim` and BuncargoBar read).
		 * Its own key, so an integration cannot overwrite `pid` or `status`.
		 */
		integrations: optional(recordOf(isRecord)),
		/** The exclusive lease this app holds (`AppConfig.exclusive`). */
		exclusive: optional(isString),
		/** `AppConfig.stopGraceMs`: how long `stop` waits for it after SIGTERM. */
		stopGraceMs: optional(refine(isFiniteNumber, (ms) => ms > 0)),
		/** `reused`: served by a process this run did not spawn, so it cannot stop it either. */
		status: isOneOf(["starting", "ready", "reused", "failed", "stopped"]),
	}),
	(app) =>
		endpointComplete(app) && (app.port !== undefined || app.kind === "worker"),
);

const isRunServiceProblem = object({
	state: isOneOf(["stopped", "missing", "unhealthy"]),
	/** The line the run printed: "postgres stopped (exit 0)", and who did it. */
	detail: isString,
	since: isString,
});

const isRunService = refine(
	object({
		kind: optional(isOneOf(["service", "job"])),
		protocol: optional(isProtocol),
		name: isString,
		/** Built-in preset, or absent for `service.custom()`. */
		preset: optional(isString),
		port: optional(isPort),
		url: optional(isString),
		loopbackUrl: optional(isString),
		publicUrl: optional(isString),
		hostname: optional(isString),
		tablePlusUrl: optional(isString),
		/** The integration stack providing it (see {@link RunEntry.stacks}); it has no container of ours. */
		stack: optional(isString),
		/** What `stop` needs to reach the container without loading the config. */
		container: optional(
			object({
				runtime: isOneOf(["docker", "apple"]),
				name: isString,
				service: optional(isString),
				binary: optional(isString),
			}),
		),
		status: isOneOf(["starting", "ready", "stopped"]),
		/**
		 * Set by the run when the container stopped, was removed or turned
		 * unhealthy under it, and cleared when it recovers. A separate field
		 * rather than a status: an older reader drops an entry whose status it
		 * does not know, and `status` stays what the run last set.
		 */
		problem: optional(isRunServiceProblem),
	}),
	endpointComplete,
);

const isRunStack = object({
	name: isString,
	/** argv, run from the checkout (or home once it is gone). Keeps data. */
	down: refine(arrayOf(isString), (argv) => argv.length > 0),
	/**
	 * The `com.docker.compose.project` label its containers carry. What stops
	 * them when `down` cannot run: a CLI that lived in a deleted checkout.
	 */
	composeProject: optional(isString),
});

const isRunTask = object({ name: isString, description: optional(isString) });

const isRunDetail = object({ label: isString, value: isString });

/**
 * Where a run is in its life, as its owner and the sweep recorded it.
 *
 * - `live`: the owner has not said it finished. It may have crashed since;
 *   only a liveness read tells, which is why readers ask {@link runPhase}.
 * - `released`: the owner exited on purpose, so its containers wait out the
 *   hold for the next run. A deliberate Ctrl-C has to be distinguishable from
 *   a crash: the crash grace is seconds, the hold minutes, and without the
 *   distinction every restart paid for a container recreate.
 * - `lost`: the sweep found the owner gone without releasing. The crash grace
 *   counts from `at`, stamped once by the sweep, so no live run pays for an
 *   accurate clock; `updatedAt` would not do, because a quiet run may not
 *   have written anything for hours before it crashed.
 */
const isRunLifecycle = oneOf(
	object({ state: isOneOf(["live"]) }),
	object({ state: isOneOf(["released", "lost"]), at: isString }),
);

/**
 * How long the containers outlive the run.
 *
 * - `checkout`: as long as the checkout exists, however the run ended
 *   (`--keep-containers`, the one-shot modes, a library `start()`).
 * - `timed`: `ms` after release; after a crash the grace applies instead.
 *   `inherited` is the hold of an earlier run whose held containers this run,
 *   which asked for none, reused: it applies from when this run ends,
 *   released or lost. Without it the newest entry said "keep forever" and a
 *   one-second script pinned a CLI run's stack for days.
 */
const isRunHold = oneOf(
	object({ kind: isOneOf(["checkout"]) }),
	object({
		kind: isOneOf(["timed"]),
		ms: refine(isFiniteNumber, (ms) => ms >= 0),
		inherited: isBoolean,
	}),
);

export const isRunEntry = object({
	/**
	 * Identifies this run; every write addresses an entry by it.
	 */
	sessionId: isString,
	processIdentity: optional(isString),
	projectPrefix: isString,
	projectName: isString,
	/** Present on throwaway suffixed runs (`buncargo ci`, `withSuffix()`), which cross-repo links ignore. */
	suffix: optional(isString),
	root: isString,
	/** Worktree directory name, or `null` in the main checkout. */
	worktree: nullable(isString),
	branch: optional(isString),
	/** Active profile name (`--profile` or `"default"` when `profiles.default` exists). */
	profile: optional(isString),
	/**
	 * The process that owns this run.
	 *
	 * Its death retires the entry, unless the run owns containers, which
	 * outlive it by design: then the entry survives, invisible to every
	 * "live runs" reader, until the sweep has torn the containers down.
	 * Never zeroed on release: the menu bar asks `kill(pid, 0)`, and pid 0
	 * is that app's own process group.
	 */
	pid: isPositiveInteger,
	startedAt: isString,
	updatedAt: isString,
	lifecycle: isRunLifecycle,
	hold: isRunHold,
	primaryApp: optional(isString),
	/**
	 * Started by `dev --detach`: no terminal shows its servers, so stopping it
	 * kills nothing anyone is watching and `stop` does not ask first.
	 */
	detached: optional(isBoolean),
	/**
	 * A detached run's idle limit: the watchdog stops it after this long with
	 * no request through buncargo's proxy and no buncargo command in its
	 * checkout (`core/run-limits.ts`). Absent for a run in a terminal, and for
	 * `dev --detach --keep`.
	 */
	idleLimitMs: optional(isPositiveInteger),
	hosts: nullable(object({ active: isBoolean, tld: isString })),
	/**
	 * How to invoke this same buncargo again.
	 *
	 * A reader stopping one app must run the build that started it, not
	 * whatever `buncargo` resolves to in its own environment. In a worktree
	 * those are routinely different versions.
	 */
	cli: object({ program: isString, script: optional(isString) }),
	apps: arrayOf(isRunApp),
	services: arrayOf(isRunService),
	/**
	 * Integration stacks (the Supabase CLI) this run started, with the command
	 * that stops each. The sweep runs it when it would tear the run's
	 * containers down: it has no config to ask.
	 */
	stacks: optional(arrayOf(isRunStack)),
	/** The config's tasks, which the menu bar runs with `buncargo run <name>`. */
	tasks: optional(arrayOf(isRunTask)),
	/** Values apps printed (`captures`), by name: what `env --get captured.*` reads. */
	captures: optional(recordOf(isString)),
	/** Non-secret env vars exported to linked checkouts (`exportEnv`, integrations). */
	exports: optional(recordOf(isString)),
	/** Labelled captures and integrations' `describe` values (e.g. "Shopify preview"). */
	details: optional(arrayOf(isRunDetail)),
});

export type RunEntry = Guarded<typeof isRunEntry>;
export type RunAppEntry = Guarded<typeof isRunApp>;
export type RunAppStatus = RunAppEntry["status"];
export type RunServiceEntry = Guarded<typeof isRunService>;
export type RunServiceStatus = RunServiceEntry["status"];
export type RunServiceProblem = Guarded<typeof isRunServiceProblem>;
export type RunStackEntry = Guarded<typeof isRunStack>;
export type RunTaskEntry = Guarded<typeof isRunTask>;
export type RunDetailEntry = Guarded<typeof isRunDetail>;
export type RunLifecycle = Guarded<typeof isRunLifecycle>;
export type RunHold = Guarded<typeof isRunHold>;

/** A run nobody has said finished. */
export const LIVE: RunLifecycle = { state: "live" };

/** Containers kept for as long as the checkout exists. */
export const CHECKOUT_HOLD: RunHold = { kind: "checkout" };

/**
 * Where a run is, for every reader of the registry: `live` while its owner
 * is alive and has not released, `released` once it exited on purpose, `lost`
 * once its owner is gone without releasing, whether or not the sweep has
 * stamped that yet.
 */
export type RunPhase = "live" | "released" | "lost";

export function runPhase(
	entry: Pick<RunEntry, "lifecycle">,
	alive: boolean,
): RunPhase {
	if (entry.lifecycle.state === "released") return "released";
	return alive ? "live" : "lost";
}

const runsRegistry = defineListRegistry<RunEntry>({
	version: REGISTRY_VERSION,
	key: "runs",
	isEntry: isRunEntry,
});

export function getRunsPath(): string {
	return stateFilePath(RUNS_FILENAME);
}

let cachedRunsRead:
	| {
			path: string;
			ino: number;
			mtimeMs: number;
			size: number;
			entries: RunEntry[];
	  }
	| undefined;

function readParsedRunsCached(path: string): RunEntry[] {
	try {
		const stat = statSync(path);
		if (
			cachedRunsRead &&
			cachedRunsRead.path === path &&
			cachedRunsRead.ino === stat.ino &&
			cachedRunsRead.mtimeMs === stat.mtimeMs &&
			cachedRunsRead.size === stat.size
		) {
			return cachedRunsRead.entries;
		}
		const entries = runsRegistry.readSync(path);
		cachedRunsRead = {
			path,
			ino: stat.ino,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			entries,
		};
		return entries;
	} catch {
		cachedRunsRead = undefined;
		return [];
	}
}

/**
 * Every live run on this machine, read synchronously and leniently (an
 * unreadable registry reads as none), for `getEnvVar`, cross-repo link
 * resolution, and `lookupRunningApp` / `lookupRunningService`. Process identity
 * is read once per process for the runs it has not seen.
 */
export function readLiveRunsSync(): RunEntry[] {
	const runs = readParsedRunsCached(getRunsPath()).filter(
		(run) => runPhase(run, isProcessAlive(run.pid)) === "live",
	);
	const identities = readProcessIdentitiesCached(
		runs.flatMap((run) => (run.processIdentity ? [run.pid] : [])),
	);
	return runs.filter((run) => {
		const actual = identities.get(run.pid);
		return (
			run.processIdentity === undefined ||
			actual === undefined ||
			actual === run.processIdentity
		);
	});
}

/**
 * What `root`'s live runs captured, the newest run winning, read the way
 * `getEnvVar` inside a user's config can: synchronously and leniently, an
 * unreadable registry reading as no captures.
 */
export function readLiveCapturesSync(root: string): Record<string, string> {
	return Object.assign(
		{},
		...readLiveRunsSync()
			.filter((run) => run.root === root)
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
			.map((run) => run.captures ?? {}),
	);
}
