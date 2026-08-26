import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readJsonDocumentSync, writeJsonDocumentSync } from "../registry-file";
import {
	DEFAULT_HOSTS_DAEMON_PORT,
	hostsDaemonPort,
	shouldSyncHostsFile,
} from "../runtime-flags";
import { sleep } from "../utils";
import { cleanHostsFile, syncHostsFile } from "./hosts-file";
import { mintCert, resolvedMkcertPath } from "./mkcert";
import {
	chownToInvokingUser,
	getDaemonConfigPath,
	getHostsStateDir,
	getPidfilePath,
} from "./paths";
import { isProxyHealthy, type LocalProxy, startLocalProxy } from "./proxy";
import { pruneHostRoutes } from "./registry";
import { isHostsServiceInstalled } from "./service";
import { describePortSquatter } from "./squatter";

const DEFAULT_HTTP_PORT = 80;
const IDLE_EXIT_MS = 30_000;

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

function writePidfile(pid: number): void {
	mkdirSync(getHostsStateDir(), { recursive: true });
	const path = getPidfilePath();
	writeFileSync(path, `${pid}\n`);
	chownToInvokingUser(path);
}

export function readDaemonPid(): number | undefined {
	const path = getPidfilePath();
	if (!existsSync(path)) return undefined;
	const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}

export async function isHostsDaemonHealthy(
	port = readDaemonConfig().httpsPort,
): Promise<boolean> {
	return isProxyHealthy(port);
}

export async function runHostsDaemon(
	options: { service?: boolean } = {},
): Promise<void> {
	const config = readDaemonConfig();
	writeDaemonConfig(config);
	writePidfile(process.pid);

	let proxy: LocalProxy | undefined;
	let lastHostKey = "";
	let idleSince: number | undefined;

	const lookup = (hostname: string) => {
		// refreshed via routes snapshot
		return routeMap.get(hostname);
	};
	const routeMap = new Map<string, number>();

	async function reload(): Promise<void> {
		const routes = await pruneHostRoutes();
		routeMap.clear();
		for (const route of routes) {
			routeMap.set(route.hostname, route.port);
		}
		const hostnames = [...routeMap.keys()].sort();
		const hostKey = hostnames.join(",");
		if (hostnames.length === 0) {
			if (!idleSince) idleSince = Date.now();
			if (
				!options.service &&
				idleSince &&
				Date.now() - idleSince > IDLE_EXIT_MS
			) {
				proxy?.stop();
				if (shouldSyncHostsFile()) {
					try {
						cleanHostsFile();
					} catch {
						// ignore
					}
				}
				process.exit(0);
			}
			return;
		}
		idleSince = undefined;

		if (shouldSyncHostsFile()) {
			try {
				syncHostsFile(hostnames);
			} catch {
				// /etc/hosts may be read-only in tests
			}
		}

		if (hostKey === lastHostKey && proxy) {
			return;
		}

		const mkcertPath = resolvedMkcertPath();
		const minted = mintCert(hostnames, { mkcertPath });
		proxy?.stop();
		proxy = await startLocalProxy({
			lookup,
			listHostnames: () => [...routeMap.keys()],
			cert: await Bun.file(minted.certPath).text(),
			key: await Bun.file(minted.keyPath).text(),
			httpsPort: config.httpsPort,
			httpPort:
				config.httpsPort === DEFAULT_HOSTS_DAEMON_PORT
					? config.httpPort
					: undefined,
		});
		lastHostKey = hostKey;
	}

	const onStop = () => {
		proxy?.stop();
		const pid = readDaemonPid();
		if (pid === process.pid) {
			try {
				unlinkSync(getPidfilePath());
			} catch {
				// already gone
			}
		}
		process.exit(0);
	};
	process.on("SIGINT", onStop);
	process.on("SIGTERM", onStop);

	await reload();
	for (;;) {
		await sleep(1000);
		await reload();
	}
}

export async function ensureHostsDaemonRunning(
	options: { allowSpawn?: boolean } = {},
): Promise<{ ok: boolean; message?: string }> {
	const config = readDaemonConfig();
	if (await isHostsDaemonHealthy(config.httpsPort)) {
		return { ok: true };
	}

	const squatter = describePortSquatter(config.httpsPort);
	if (squatter && !isHostsServiceInstalled()) {
		return { ok: false, message: squatter };
	}

	if (options.allowSpawn === false) {
		return { ok: false, message: "Named-hosts daemon is not running." };
	}

	const bin = process.argv[1];
	if (!bin) {
		return {
			ok: false,
			message: "Could not locate the buncargo CLI to start the hosts daemon.",
		};
	}
	const child = spawn(process.execPath, [bin, "hosts", "daemon"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	for (let attempt = 0; attempt < 20; attempt++) {
		if (await isHostsDaemonHealthy(config.httpsPort)) {
			return { ok: true };
		}
		await sleep(150);
	}
	return {
		ok: false,
		message:
			"Named-hosts daemon did not become healthy. Run `buncargo hosts install` or use localhost:port.",
	};
}
