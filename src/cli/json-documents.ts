import type { CheckSlotStatus } from "../core/check-slots";
import type { FileState } from "../core/checkout-files/sync";
import type { LeaseEntry } from "../core/leases";
import type { StrayLoopbackUrl } from "../core/loopback-env";
import type { RemovalRecord } from "../core/removal-log";
import type { REGISTRY_VERSION, RunEntry } from "../core/run-registry";
import type { InfisicalScope } from "../core/secrets/scope";
import type {
	HostsRuntime,
	LinkInspection,
	PortOffsetProvenance,
	ResolvedLink,
} from "../types";
import type { CheckMode, DeferredTests } from "./commands/check/plan";
import type { RunFailure } from "./run-failure";

/**
 * The JSON documents the CLI prints, one type each. Scripts and agents parse
 * them, so a removed or renamed key is a breaking change; each command builds
 * its document with `satisfies` so the two cannot drift apart.
 */

/** `buncargo dev --detach --json`: how the wait for the background run ended. */
export interface DetachedResultJson {
	version: 1;
	/**
	 * `up`: every app is up. `finished`: the run exited cleanly with nothing
	 * to keep running. `failed`: the run failed or an app did not come up (the
	 * others keep running). `timeout`: apps still starting; the run goes on.
	 */
	outcome: "up" | "finished" | "failed" | "timeout";
	exitCode: number;
	pid: number;
	/** The run's own output. */
	log: string;
	apps: { name: string; status: string; url: string | null }[];
	/** Why named URLs fell back to `localhost:port`; empty when they did not. */
	hostsWarnings: string[];
	/** Warnings about optional cross-repo links (ambiguity, stale or mismatched pins). */
	linkWarnings: string[];
	failures: RunFailure[];
	/** How long the run may idle before it stops itself; null for never. */
	idleLimitMs: number | null;
}

/** `buncargo runs --json`: every live run on this machine and the leases. */
export interface RunsJson {
	/** The `runs.json` schema its entries follow. */
	version: typeof REGISTRY_VERSION;
	/** `idleStopsAt`: when a detached run stops if nothing uses it first. */
	runs: (RunEntry & { idleStopsAt?: string })[];
	leases: LeaseEntry[];
}

/**
 * An app a running `dev` left out (not in its `--apps` or profile), which
 * `command` starts.
 */
export interface StartableAppJson {
	name: string;
	/** What starting it starts, in order: it and the `requiredApps` the run has not. */
	apps: string[];
	/** Services it needs that the run did not start; empty when it can start in the run. */
	missingServices: string[];
	/**
	 * `buncargo restart <app>` when it can start in the run; otherwise the
	 * `buncargo dev --apps=` that starts a new run with it, once this one ends.
	 */
	command: string;
}

/** `buncargo status --json`: this checkout's runs, ports, containers and URLs. */
export interface StatusJson {
	/**
	 * First, so `| head` keeps them: each with `degraded` while a service is
	 * down under it, and the apps it left out and can start (`startable`).
	 */
	runs: (RunEntry & {
		health: "ok" | "degraded";
		startable: StartableAppJson[];
	})[];
	project: string;
	root: string;
	portOffset: number;
	portOffsetProvenance: PortOffsetProvenance;
	/** Where the next `dev` moves an unclaimed block, and why; absent when it keeps it. */
	plannedOffset?: { offset: number; reason: string };
	composeFile: string;
	runtime: { name: string; running: boolean };
	checkSlots: CheckSlotStatus;
	ports: Record<
		string,
		{ port: number; state: "free" | "foreign" | "ours"; owner: string | null }
	>;
	urls: Record<string, string>;
	containers:
		{ service: string; name: string; status: string }[] | { error: string };
	hosts: {
		mode: HostsRuntime["mode"];
		tld: string;
		active: boolean;
		plan: { hostname: string; targetPort: number }[];
		tailscaleUrls: Record<string, string>;
	} | null;
	tunnels: { name: string; publicUrl: string }[];
	recentStops: (RemovalRecord & { description: string })[];
	/** `buncargo env set` keys; names only. */
	envOverrides: string[];
	/** Cross-repo links declared in config, with live target and status. */
	links: LinkInspection[];
	strayLoopbackUrls: (StrayLoopbackUrl & { message: string })[];
}

/** `buncargo restart --json`: what the run answered for each app. */
export interface RestartJson {
	version: 1;
	exitCode: number;
	/** One per app asked for, in order, up to the first that did not restart. */
	results: RestartResultJson[];
}

export interface RestartResultJson {
	app: string;
	/**
	 * `restarted`: its process was replaced. `started`: the start of an app
	 * the run left out began (`apps`; none when it was already starting).
	 * `failed`: it did not come back, the run did not answer, or the app is
	 * ambiguous between runs. `not-found`: no run started it or can.
	 * `refused`: the run would not (see `message`).
	 */
	outcome: "restarted" | "started" | "failed" | "not-found" | "refused";
	/** What `restart` prints without `--json`. */
	message: string;
	/** What to do next. */
	hints: string[];
	/** For `started`: what it starts, it and the `requiredApps` the run had not. */
	apps?: string[];
}

/** `buncargo links --json`: cross-repo links and their live status. */
export interface LinksJson {
	version: 1;
	root: string;
	project: string;
	links: LinkInspection[];
	errors: string[];
	warnings: string[];
}

/** `buncargo env`: the checkout's environment as its live run sees it. */
export interface EnvJson {
	projectName: string;
	ports: Record<string, number>;
	urls: Record<string, string>;
	loopbackUrls: Record<string, string>;
	portOffset: number;
	portOffsetProvenance: PortOffsetProvenance;
	isWorktree: boolean;
	localIp: string;
	root: string;
	captured: Record<string, string>;
	/** Live cross-repo links (`null` when not running, ambiguous or disabled). */
	links: Record<string, ResolvedLink | null>;
	details: Record<string, unknown>;
	hosts: {
		active: boolean;
		mode: HostsRuntime["mode"];
		tld: string;
		plan: HostsRuntime["plan"];
		tailscaleUrls: Record<string, string>;
	} | null;
	/** What `exec`, tasks and the apps are given, without their secrets. */
	vars: Record<string, string>;
	/** `buncargo env set` keys, already applied to `vars`. */
	overrides: string[];
}

/** `buncargo secrets check --json`: whether every Infisical scope is readable. */
export interface SecretsCheckJson {
	ok: boolean;
	exitCode: number;
	/** The `infisical login` commands to run first. */
	logins: string[];
	scopes: (InfisicalScope & {
		usedBy: string[];
		ok: boolean;
		keys?: number;
		error?: string;
		fix?: string;
	})[];
}

/** `buncargo files status --json`: each checkout file's state. */
export interface FilesStatusJson {
	version: 1;
	repoKey: string;
	files: { path: string; state: FileState; machine: boolean }[];
}

/** `buncargo check --list --json`: the steps a check would run. */
export interface CheckPlanJson {
	mode: CheckMode;
	steps: { name: string; label: string; command: string }[];
	deferredTests: DeferredTests | null;
}

/** `buncargo gc --json`: orphaned stacks, volumes and stale port claims cleaned or planned. */
export interface GcJson {
	dryRun: boolean;
	stacks: {
		projectName: string;
		root: string;
		runtime: string;
		reason: string;
	}[];
	volumes: {
		name: string;
		project: string;
		runtime: string;
		root: string;
		reason: string;
		removed: boolean;
	}[];
	claims: {
		key: string;
		root: string;
		projectName: string;
		offset: number;
		reason: string;
	}[];
	skippedVolumes: number;
	failed: { target: string; error: string }[];
}
