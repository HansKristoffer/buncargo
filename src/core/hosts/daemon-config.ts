import { existsSync, readFileSync, rmSync } from "node:fs";
import { readJsonDocumentSync, writeJsonDocumentSync } from "../registry-file";
import { hostsDaemonPort } from "../runtime-flags";
import { chownToInvokingUser } from "../state-paths";
import { getDaemonConfigPath, getPidfilePath } from "./paths";

/**
 * What the `:443` proxy was configured with, and which process is running it.
 *
 * Shared by the daemon itself and by every CLI command that has to find it, so
 * it lives below both: the daemon must not import the CLI-side client, which
 * reaches into the container runtimes to name a port squatter.
 */

const DEFAULT_HTTP_PORT = 80;

export interface HostsDaemonConfig {
	httpsPort: number;
	httpPort: number;
	tls: boolean;
}

function validateDaemonConfig(
	value: unknown,
): Partial<HostsDaemonConfig> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const config = value as Partial<HostsDaemonConfig>;
	return {
		httpsPort:
			typeof config.httpsPort === "number" ? config.httpsPort : undefined,
		httpPort: typeof config.httpPort === "number" ? config.httpPort : undefined,
		tls: typeof config.tls === "boolean" ? config.tls : undefined,
	};
}

/** What a daemon starting now binds: its environment, never the stored file. */
export function daemonConfigFromFlags(): HostsDaemonConfig {
	return {
		httpsPort: hostsDaemonPort(),
		httpPort: DEFAULT_HTTP_PORT,
		tls: true,
	};
}

/** What the running daemon bound, as it recorded it; the flags when none did. */
export function readDaemonConfig(): HostsDaemonConfig {
	const stored =
		readJsonDocumentSync(getDaemonConfigPath(), validateDaemonConfig) ?? {};
	const flags = daemonConfigFromFlags();
	return {
		httpsPort: stored.httpsPort ?? flags.httpsPort,
		httpPort: stored.httpPort ?? flags.httpPort,
		tls: stored.tls ?? flags.tls,
	};
}

export function writeDaemonConfig(config: HostsDaemonConfig): void {
	writeJsonDocumentSync(getDaemonConfigPath(), config, {
		afterWrite: chownToInvokingUser,
	});
}

/**
 * Forget the running daemon as it exits, when that daemon is this process.
 *
 * Every exit, not just a signal: an idle exit that left the pidfile behind
 * named a dead pid, and a leftover config pointed every reader at the port a
 * foreground daemon had chosen. A daemon that started since owns both.
 */
export function releaseDaemonState(pid: number): void {
	if (readDaemonPid() !== pid) return;
	rmSync(getPidfilePath(), { force: true });
	rmSync(getDaemonConfigPath(), { force: true });
}

export function readDaemonPid(): number | undefined {
	const path = getPidfilePath();
	if (!existsSync(path)) return undefined;
	const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}
