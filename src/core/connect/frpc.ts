import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { abortableSleep } from "../deadline";
import { connectProcessEnv } from "../runtime-flags";
import { installFrp } from "./binary";
import { startGuardedChild } from "./child-guard";
import { newCredential } from "./client";
import { listenEndpoint } from "./endpoint";
import { type Relay, record, validPort } from "./protocol";
export async function freePort() {
	const server = createServer();
	const endpoint = await listenEndpoint(server);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return Number(endpoint.split(":")[1]);
}
export interface FrpcConfig {
	relay: Relay;
	user: string;
	credential: string;
	proxies?: Record<string, unknown>[];
	visitors?: Record<string, unknown>[];
}
/** frpc owns the transport. Its authenticated administration endpoint stays on loopback. */
export async function startFrpc(
	config: FrpcConfig,
	signal?: AbortSignal,
	trustedCA = rootCertificates.join("\n"),
) {
	if (
		!validPort(config.relay.port) ||
		!/^[a-z0-9.-]+$/.test(config.relay.host) ||
		!/^[a-z0-9.-]+$/.test(config.relay.serverName)
	)
		throw new Error("Invalid relay configuration");
	const binary = await installFrp("frpc", signal),
		directory = await mkdtemp(join(tmpdir(), "bc-frp-"));
	const port = await freePort(),
		password = newCredential("admin"),
		path = join(directory, "frpc.json");
	const ca = join(directory, "ca.pem");
	await writeFile(ca, trustedCA, { mode: 0o600 });
	const content = {
		serverAddr: config.relay.host,
		serverPort: config.relay.port,
		user: config.user,
		metadatas: { credential: config.credential },
		auth: {
			method: "token",
			token: "",
			additionalScopes: ["HeartBeats", "NewWorkConns"],
		},
		transport: {
			protocol: "tcp",
			tcpMux: true,
			heartbeatInterval: 10,
			heartbeatTimeout: 30,
			tls: {
				enable: true,
				serverName: config.relay.serverName,
				trustedCaFile: ca,
			},
		},
		webServer: { addr: "127.0.0.1", port, user: "buncargo", password },
		loginFailExit: false,
		proxies: config.proxies ?? [],
		visitors: config.visitors ?? [],
	};
	await writeFile(path, JSON.stringify(content), { mode: 0o600 });
	const verify = Bun.spawn([binary, "verify", "-c", path], {
		stdout: "ignore",
		stderr: "ignore",
		env: connectProcessEnv(),
	});
	if ((await verify.exited) !== 0) {
		await rm(directory, { recursive: true, force: true });
		throw new Error("Invalid frpc configuration");
	}
	const child = startGuardedChild(binary, ["-c", path], directory);
	const close = () => child.close();
	const admin = async (endpoint: string) => {
		const response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
			headers: {
				authorization: `Basic ${Buffer.from(`buncargo:${password}`).toString("base64")}`,
			},
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) throw new Error("frpc administration request failed");
		return response;
	};
	const status = async () => record(await (await admin("status")).json());
	// Reload only proxy definitions: keeping the login/multiplexer alive preserves other recipients' streams.
	const reload = async (proxies: Record<string, unknown>[]) => {
		await writeFile(`${path}.next`, JSON.stringify({ ...content, proxies }), {
			mode: 0o600,
		});
		await rename(`${path}.next`, path);
		await (await admin("reload?strictConfig=true")).text();
	};
	try {
		for (let i = 0; i < 100; i++) {
			signal?.throwIfAborted();
			if (!child.alive)
				throw new Error("frpc exited; check relay TLS and credentials");
			try {
				await status();
				return { close, status, reload, alive: () => child.alive };
			} catch {}
			await abortableSleep(100, signal);
		}
		throw new Error("frpc administration listener did not start");
	} catch (e) {
		await close();
		throw e;
	}
}
export type Frpc = Awaited<ReturnType<typeof startFrpc>>;
export function runningProxies(status: Record<string, unknown>): string[] {
	return Object.values(status).flatMap((value) =>
		Array.isArray(value)
			? value
					.filter((v) => record(v).status === "running")
					.map((v) => String(record(v).name))
			: [],
	);
}
