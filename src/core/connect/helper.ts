import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { withFileLock } from "../file-lock";
import {
	matchesProcessIdentity,
	readProcessIdentity,
} from "../process-identity";
import { writeJsonDocument } from "../registry-file";
import { sleep } from "../sleep";
import { stateFilePath } from "../state-paths";
import { deviceClient, readDevice } from "./device";
import { ConnectionForwards } from "./forwards";
import {
	identifier,
	jsonBody,
	makeSecret,
	object,
	validPort,
} from "./protocol";

interface HelperState {
	version: 1;
	pid: number;
	identity?: string;
	port: number;
	secret: string;
}
const helperPath = () => stateFilePath("connect-helper.json");
async function readHelper(): Promise<HelperState | undefined> {
	try {
		const v = object(JSON.parse(await readFile(helperPath(), "utf8")));
		if (
			v.version !== 1 ||
			typeof v.pid !== "number" ||
			!validPort(v.port) ||
			typeof v.secret !== "string"
		)
			return;
		return v as unknown as HelperState;
	} catch {
		return;
	}
}
async function healthy(state: HelperState | undefined): Promise<boolean> {
	if (!state || !matchesProcessIdentity(state.pid, state.identity))
		return false;
	try {
		const r = await fetch(`http://127.0.0.1:${state.port}/health`, {
			headers: { authorization: `Bearer ${state.secret}` },
			redirect: "error",
			signal: AbortSignal.timeout(1000),
		});
		return (
			r.ok &&
			((await r.json()) as { service?: string }).service ===
				"buncargo-connect-helper"
		);
	} catch {
		return false;
	}
}
async function ensureHelper(): Promise<HelperState> {
	return withFileLock(helperPath(), async () => {
		const previous = await readHelper();
		if (await healthy(previous)) return previous as HelperState;
		const log = await open(stateFilePath("connect-helper.log"), "a", 0o600);
		const child = spawn(
			process.execPath,
			[process.argv[1], "connect", "serve"],
			{ detached: true, stdio: ["ignore", log.fd, log.fd] },
		);
		child.unref();
		await log.close();
		for (let i = 0; i < 50; i++) {
			await sleep(100);
			const state = await readHelper();
			if (state && state.pid === child.pid && (await healthy(state)))
				return state;
		}
		throw new Error(
			"Connection helper did not start; inspect ~/.buncargo/connect-helper.log",
		);
	});
}
export async function helperAction(
	action: "open" | "disconnect",
	session: string,
	target: string,
): Promise<{ url?: string; port?: number }> {
	if (!identifier(session) || !identifier(target))
		throw new Error("Invalid remote target");
	const helper = await ensureHelper();
	const r = await fetch(`http://127.0.0.1:${helper.port}/${action}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${helper.secret}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ session, target }),
		redirect: "error",
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok)
		throw new Error("Remote target is unavailable; refresh the directory");
	return r.json() as Promise<{ url?: string; port?: number }>;
}
/** Authenticated loopback control server; remote metadata never supplies executable paths. */
export async function runConnectionHelper(): Promise<void> {
	await withFileLock(
		stateFilePath("connect-helper-owner"),
		async () => {
			const device = await readDevice();
			if (!device) throw new Error("Create a connection token first");
			const client = deviceClient(device),
				secret = makeSecret();
			const forwards = new ConnectionForwards();
			// Directory polling and UI actions share one queue to keep listener ownership atomic.
			let pending: Promise<unknown> = Promise.resolve();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				maxRequestBodySize: 8192,
				async fetch(request) {
					if (
						request.headers.get("authorization") !== `Bearer ${secret}` ||
						request.headers.has("origin")
					)
						return new Response("Unauthorized", { status: 401 });
					const path = new URL(request.url).pathname;
					if (path === "/health")
						return Response.json({ service: "buncargo-connect-helper" });
					if (
						request.method !== "POST" ||
						!["/open", "/disconnect"].includes(path)
					)
						return new Response("Not found", { status: 404 });
					const operation = pending
						.catch(() => {})
						.then(async () => {
							try {
								const body = await jsonBody(request);
								if (!identifier(body.session) || !identifier(body.target))
									throw new Error();
								const session = body.session,
									targetId = body.target;
								if (path === "/disconnect") {
									await forwards.disconnect(session, targetId);
									return Response.json({ ok: true });
								}
								const directory = await client.list(
									device.recipientId,
									device.owner,
								);
								await forwards.reconcile(directory);
								const run = directory.runs.find((r) => r.sessionId === session);
								if (!run) throw new Error("Remote session unavailable");
								const forward = await forwards.open(run, targetId);
								return Response.json({ url: forward.url, port: forward.port });
							} catch {
								return new Response("Remote target unavailable", {
									status: 502,
								});
							}
						});
					pending = operation;
					return operation;
				},
			});
			await writeJsonDocument(helperPath(), {
				version: 1,
				pid: process.pid,
				identity: readProcessIdentity(process.pid),
				port: server.port,
				secret,
			});
			// Expiring connections already fail closed in the connector. Also retire idle listeners.
			let polling = false;
			const timer = setInterval(() => {
				if (polling || !forwards.size) return;
				polling = true;
				pending = pending
					.catch(() => {})
					.then(() => client.list(device.recipientId, device.owner))
					.then((directory) => forwards.reconcile(directory))
					.catch(() => forwards.close())
					.finally(() => {
						polling = false;
					});
			}, 30_000);
			await new Promise<void>((resolve) => {
				const done = () => {
					process.off("SIGINT", done);
					process.off("SIGTERM", done);
					resolve();
				};
				process.on("SIGINT", done);
				process.on("SIGTERM", done);
			});
			clearInterval(timer);
			await pending.catch(() => {});
			await forwards.close();
			await server.stop(true);
		},
		{ timeoutMs: 1000 },
	);
}
