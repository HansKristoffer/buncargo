import { existsSync, readFileSync } from "node:fs";
import { readJsonDocumentSync, writeJsonDocumentSync } from "../registry-file";
import { hostsDaemonPort } from "../runtime-flags";
import {
	chownToInvokingUser,
	getDaemonConfigPath,
	getPidfilePath,
} from "./paths";

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

export function readDaemonConfig(): HostsDaemonConfig {
	const stored =
		readJsonDocumentSync(getDaemonConfigPath(), validateDaemonConfig) ?? {};
	return {
		httpsPort: stored.httpsPort ?? hostsDaemonPort(),
		httpPort: stored.httpPort ?? DEFAULT_HTTP_PORT,
		tls: stored.tls ?? true,
	};
}

export function writeDaemonConfig(config: HostsDaemonConfig): void {
	writeJsonDocumentSync(getDaemonConfigPath(), config, {
		afterWrite: chownToInvokingUser,
	});
}

export function readDaemonPid(): number | undefined {
	const path = getPidfilePath();
	if (!existsSync(path)) return undefined;
	const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}
