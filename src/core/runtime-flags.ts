import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_ORIGIN } from "./connect/origin";

/**
 * Every environment variable buncargo reads, in one place.
 *
 * Each getter takes the environment explicitly (defaulting to `process.env`) so
 * behavior is testable without mutating the real process, and so nothing is
 * captured at import time - a flag set by the CLI before a call still applies.
 */

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const raw = env[name]?.trim();
	return raw ? raw : undefined;
}

/** Workspace identity injected into app processes by the dev environment. */
export function devWorkspaceId(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, "BUNCARGO_WORKSPACE_ID");
}

/** Read a non-negative integer, falling back to `fallback` when unset or unusable. */
function readInt(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	min = 0,
): number {
	const raw = readTrimmed(env, name);
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/** Resolve a binary path override, failing loudly when it points nowhere. */
function readBinaryOverride(
	env: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const override = readTrimmed(env, name);
	if (override && !existsSync(override)) {
		throw new Error(`${name} does not exist: ${override}`);
	}
	return override;
}

// ═══════════════════════════════════════════════════════════════════════════
// CI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every environment variable that can mean "this is CI".
 *
 * Exported so a test that needs to look like a developer's machine can clear
 * all of them. Clearing `CI` alone is not enough — GitHub Actions also sets
 * `GITHUB_ACTIONS`, so a test that only deleted `CI` passed locally and failed
 * on the very provider it was running on.
 */
export const CI_ENV_VARS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"JENKINS_URL",
] as const;

/**
 * Detect a CI environment.
 *
 * This is the single definition; named hosts, Docker auto-start, and server
 * readiness timeouts all key off it, so they cannot disagree per provider.
 */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env.CI === "true" ||
		env.CI === "1" ||
		env.GITHUB_ACTIONS === "true" ||
		env.GITLAB_CI === "true" ||
		env.CIRCLECI === "true" ||
		env.JENKINS_URL !== undefined
	);
}

/** `BUNCARGO_BAR=0` - turn the menu bar offer off without persisting a decline. */
export function barOfferOptedOut(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_BAR === "0";
}

// ═══════════════════════════════════════════════════════════════════════════
// Ports
// ═══════════════════════════════════════════════════════════════════════════

/** `BUNCARGO_PORT_OFFSET` - hard port offset that skips hashing and probing. */
export function portOffsetOverride(
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	const raw = env.BUNCARGO_PORT_OFFSET;
	if (!raw) return undefined;
	const offset = Number(raw);
	if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
		throw new Error(
			`BUNCARGO_PORT_OFFSET must be an integer between 0 and 10000, received "${raw}"`,
		);
	}
	return offset;
}

// ═══════════════════════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════════════════════

/** `BUNCARGO_TIMING=1` - print a per-phase breakdown of `dev` startup. */
export function isTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.BUNCARGO_TIMING === "1" || env.BUNCARGO_TIMING === "true";
}

/**
 * `BUNCARGO_DETACHED=1` - set by `dev --detach` on the run it starts in the
 * background, so the run registry can say no terminal is watching it.
 */
export function isDetachedRun(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.BUNCARGO_DETACHED === "1";
}

/**
 * `BUNCARGO_REEXEC` - set by a buncargo that handed over to the project's own
 * installed buncargo (`cli/version-guard.ts`), so that one never hands over
 * again. Holds the version that handed over.
 */
export const REEXEC_ENV = "BUNCARGO_REEXEC";

export function reexecedFrom(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, REEXEC_ENV);
}

// ═══════════════════════════════════════════════════════════════════════════
// Container runtime
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `BUNCARGO_CONTAINER_RUNTIME` - pick the backend that runs the services.
 *
 * Returns the raw string: validating it against the known names here would
 * duplicate the check the resolver already has to make for the config value.
 */
export function containerRuntimeOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, "BUNCARGO_CONTAINER_RUNTIME");
}

/** `BUNCARGO_CONTAINER_BINARY` - use this runtime binary instead of the PATH lookup. */
export function containerBinaryOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readBinaryOverride(env, "BUNCARGO_CONTAINER_BINARY");
}

// ═══════════════════════════════════════════════════════════════════════════
// Named hosts
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_HOSTS_DAEMON_PORT = 443;

/**
 * How named hosts are served on this machine, from `BUNCARGO_HOSTS`.
 *
 * - `loopback` (unset): `https://*.localhost` through the root hosts daemon.
 * - `tailscale`: each app on its own HTTPS port of the machine's MagicDNS
 *   name, through Tailscale Serve. For a remote machine, where `*.localhost`
 *   resolves to the viewer's own computer.
 * - `off` (`0`, and always in CI): `http://localhost:port`.
 *
 * Any other value is the default, as it was before the modes existed.
 */
export type HostsMode = "loopback" | "tailscale" | "off";

export function hostsMode(env: NodeJS.ProcessEnv = process.env): HostsMode {
	if (isCI(env)) return "off";
	const raw = readTrimmed(env, "BUNCARGO_HOSTS");
	if (raw === "0") return "off";
	if (raw === "tailscale") return "tailscale";
	return "loopback";
}

/**
 * `BUNCARGO_URL_HOST` - the host in app URLs, for a machine people reach from
 * another one (a Tailscale name, say). Service URLs and health checks stay on
 * `localhost`: only processes on this machine use them.
 */
export function urlHostOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, "BUNCARGO_URL_HOST");
}

/**
 * `BUNCARGO_TAILNET_DIRECTORY=0` - do not list this machine's runs to
 * BuncargoBar on other machines of its tailnet.
 */
export function tailnetDirectoryEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_TAILNET_DIRECTORY !== "0";
}

/**
 * `BUNCARGO_WATCHDOG_PARENT=<pid>:<identity>` - a process the watchdog exits
 * once it is gone. The test preload sets it, so a watchdog a test started ends
 * with the test run; a real watchdog outlives the run that started it.
 */
export function watchdogParent(
	env: NodeJS.ProcessEnv = process.env,
): { pid: number; identity?: string } | undefined {
	const raw = readTrimmed(env, "BUNCARGO_WATCHDOG_PARENT");
	if (!raw) return undefined;
	const [pidText = "", ...rest] = raw.split(":");
	const pid = Number(pidText);
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	const identity = rest.join(":");
	return { pid, identity: identity || undefined };
}

/** `BUNCARGO_LOCAL_IP` - the address `<app>Local` URLs use instead of the first network interface's. */
export function localIpOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, "BUNCARGO_LOCAL_IP");
}

/**
 * `BUNCARGO_PRUNE_DELETED_CHECKOUTS=1` - the sweep also removes the volumes of
 * a checkout whose directory is gone. For machines where worktrees come and go
 * by the hundred; off by default, because a volume is someone's database.
 */
export function pruneDeletedCheckoutVolumes(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_PRUNE_DELETED_CHECKOUTS === "1";
}

/**
 * `BUNCARGO_SYSTEMD_SCOPE=0` - start the watchdog, detached runs and the
 * sharing coordinator in the caller's cgroup, not a systemd scope of their own.
 */
export function systemdScopeEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_SYSTEMD_SCOPE !== "0";
}

/** `BUNCARGO_HOSTS_PORT` - port the loopback proxy daemon listens on. */
export function hostsDaemonPort(
	env: NodeJS.ProcessEnv = process.env,
	fallback = DEFAULT_HOSTS_DAEMON_PORT,
): number {
	return readInt(env, "BUNCARGO_HOSTS_PORT", fallback, 1);
}

/** `BUNCARGO_SYNC_HOSTS=0` - skip writing the managed `/etc/hosts` block. */
export function shouldSyncHostsFile(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_SYNC_HOSTS !== "0";
}

/** `BUNCARGO_MKCERT_PATH` - use this mkcert binary instead of downloading one. */
export function mkcertPathOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readBinaryOverride(env, "BUNCARGO_MKCERT_PATH");
}

/** `BUNCARGO_MKCERT_VERSION` - release tag for the bundled mkcert download. */
export function mkcertVersion(env: NodeJS.ProcessEnv = process.env): string {
	return readTrimmed(env, "BUNCARGO_MKCERT_VERSION") ?? "v1.4.4";
}

// ═══════════════════════════════════════════════════════════════════════════
// Secrets
// ═══════════════════════════════════════════════════════════════════════════

/** `BUNCARGO_INFISICAL_PATH` - use this infisical binary instead of the PATH lookup. */
export function infisicalPathOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readBinaryOverride(env, "BUNCARGO_INFISICAL_PATH");
}

/**
 * An Infisical universal-auth identity (`INFISICAL_CLIENT_ID` +
 * `INFISICAL_CLIENT_SECRET`), for commands that fetch secrets themselves
 * (apps, `exec`, migrations, the seed) where no CLI session exists, such as CI.
 */
export function infisicalMachineCredentials(
	env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret: string } | undefined {
	const clientId = readTrimmed(env, "INFISICAL_CLIENT_ID");
	const clientSecret = readTrimmed(env, "INFISICAL_CLIENT_SECRET");
	return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * The machine identity file hanzio also reads when the environment names no
 * identity: `INFISICAL_UNIVERSAL_AUTH_FILE`, else
 * `<home>/.infisical/universal-auth.json`. Undefined while
 * `INFISICAL_CLIENT_ID` or `INFISICAL_CLIENT_SECRET` is set, even alone.
 * `home` comes from the caller (`resolveUserHome`), which keeps this module
 * free of state-paths for the runtime entry point.
 */
export function infisicalUniversalAuthFile(
	env: NodeJS.ProcessEnv,
	home: string,
): string | undefined {
	if (
		readTrimmed(env, "INFISICAL_CLIENT_ID") ||
		readTrimmed(env, "INFISICAL_CLIENT_SECRET")
	)
		return undefined;
	return (
		readTrimmed(env, "INFISICAL_UNIVERSAL_AUTH_FILE") ??
		join(home, ".infisical", "universal-auth.json")
	);
}

/** `SECRETS_ENV` - Infisical environment slug, when the config does not name one. */
export function secretsEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, "SECRETS_ENV");
}

// ═══════════════════════════════════════════════════════════════════════════
// Public tunnels
// ═══════════════════════════════════════════════════════════════════════════

/** `BUNCARGO_CLOUDFLARED_PATH` - use this cloudflared binary instead of the cache. */
export function cloudflaredPathOverride(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readBinaryOverride(env, "BUNCARGO_CLOUDFLARED_PATH");
}

/** `CLOUDFLARED_VERSION` - release tag for the bundled cloudflared download. */
export function cloudflaredVersion(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return readTrimmed(env, "CLOUDFLARED_VERSION") ?? "2026.3.0";
}

/** `BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS` - delay between starting exposed targets. */
export function exposeTunnelStaggerMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return readInt(env, "BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS", 900);
}

/** `BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS` - retries after a transient tunnel error. */
export function quickTunnelMaxAttempts(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return readInt(env, "BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS", 5, 1);
}

/** `BUNCARGO_QUICK_TUNNEL_RETRY_BASE_MS` - backoff base; delay is `base × attempt`. */
export function quickTunnelRetryBaseMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return readInt(env, "BUNCARGO_QUICK_TUNNEL_RETRY_BASE_MS", 2000);
}

/** `BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS` - max wait for a public URL; `0` disables. */
export function quickTunnelUrlTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return readInt(env, "BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS", 30_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Typecheck
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `BUNCARGO_TYPECHECK_CONCURRENCY` - override the default typecheck pool size.
 * Must be a positive integer when set.
 */
export function typecheckConcurrencyOverride(
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	const raw = readTrimmed(env, "BUNCARGO_TYPECHECK_CONCURRENCY");
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
		throw new Error(
			`BUNCARGO_TYPECHECK_CONCURRENCY must be a positive integer, received "${raw}"`,
		);
	}
	return parsed;
}

/**
 * `BUNCARGO_CHECK_SLOTS` - how many heavy checks may run at once across every
 * checkout on the machine. Default 3; 0 turns the cap off.
 */
export function checkSlotCount(env: NodeJS.ProcessEnv = process.env): number {
	return readInt(env, "BUNCARGO_CHECK_SLOTS", 3);
}

/**
 * `BUNCARGO_CHECK_SLOT` - the slot lock file this process tree already holds.
 * Set by `withCheckSlot` for its children, so a nested check never waits on
 * the slot its own parent holds.
 */
export const CHECK_SLOT_ENV = "BUNCARGO_CHECK_SLOT";

export function heldCheckSlot(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return readTrimmed(env, CHECK_SLOT_ENV);
}

/** Sharing credentials are consumed by the coordinator, never frontend processes. */
export function connectTokens(env: NodeJS.ProcessEnv = process.env): string[] {
	const tokens = [
		...new Set(
			(env.BUNCARGO_CONNECT_TOKENS ?? "")
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
		),
	];
	if (
		tokens.length > 16 ||
		tokens.some((t) => !/^bc_share_[a-f0-9]{64}$/.test(t))
	)
		throw new Error(
			"BUNCARGO_CONNECT_TOKENS must contain up to 16 comma-separated connection tokens.",
		);
	return tokens;
}
export function connectName(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const name = env.BUNCARGO_CONNECT_NAME?.trim();
	if (
		name &&
		(name.length > 80 ||
			[...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
	)
		throw new Error(
			"BUNCARGO_CONNECT_NAME must be at most 80 characters without control characters.",
		);
	return name || undefined;
}
export function connectOrigin(env: NodeJS.ProcessEnv = process.env): string {
	const url = new URL(env.BUNCARGO_CONNECT_URL ?? CONNECT_ORIGIN);
	if (
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1"].includes(url.hostname)
			)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("BUNCARGO_CONNECT_URL must be an HTTPS origin.");
	return url.origin;
}
/** Named here so `child-env.ts` can withhold it without reading `BUNCARGO_*` itself. */
export const CONNECT_TOKENS_ENV = "BUNCARGO_CONNECT_TOKENS";
export function frpTestsEnabled(env: NodeJS.ProcessEnv = process.env) {
	return env.BUNCARGO_TEST_FRP === "1";
}
