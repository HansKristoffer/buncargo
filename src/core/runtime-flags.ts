import { existsSync } from "node:fs";

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
// Named hosts
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_HOSTS_DAEMON_PORT = 443;

/** `BUNCARGO_HOSTS=0` (or CI) - fall back to `http://localhost:port`. */
export function isHostsForcedOff(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_HOSTS === "0" || isCI(env);
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
