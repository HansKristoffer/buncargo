import type { CheckSlotStatus } from "../core/check-slots";
import type { FileState } from "../core/checkout-files/sync";
import type { LeaseEntry } from "../core/leases";
import type { StrayLoopbackUrl } from "../core/loopback-env";
import type { RemovalRecord } from "../core/removal-log";
import type { RunEntry } from "../core/run-registry";
import type { InfisicalScope } from "../core/secrets/scope";
import type { HostsRuntime, PortOffsetProvenance } from "../types";
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
	failures: RunFailure[];
	/** How long the run may idle before it stops itself; null for never. */
	idleLimitMs: number | null;
}

/** `buncargo runs --json`: every live run on this machine and the leases. */
export interface RunsJson {
	version: 1;
	/** `idleStopsAt`: when a detached run stops if nothing uses it first. */
	runs: (RunEntry & { idleStopsAt?: string })[];
	leases: LeaseEntry[];
}

/** `buncargo status --json`: this checkout's runs, ports, containers and URLs. */
export interface StatusJson {
	/** First, so `| head` keeps them: each with `degraded` while a service is down under it. */
	runs: (RunEntry & { health: "ok" | "degraded" })[];
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
	strayLoopbackUrls: (StrayLoopbackUrl & { message: string })[];
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
