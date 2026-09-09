/** Live release smoke: publish disposable fixtures, exercise transport, and remove every grant. */

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { newCredential, request } from "../src/core/connect/client";
import {
	type Frpc,
	freePort,
	runningProxies,
	startFrpc,
} from "../src/core/connect/frpc";
import { createGate } from "../src/core/connect/gate";
import {
	type PublicationLease,
	parseDirectory,
	type Receiver,
	type RunInput,
	type VisitorLease,
} from "../src/core/connect/protocol";
import { abortableSleep } from "../src/core/deadline";
import { connectOrigin } from "../src/core/runtime-flags";

const origin = connectOrigin(),
	credential = newCredential("pub"),
	clients: Frpc[] = [];
const payload = randomBytes(20 * 1024 * 1024);
const app = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	fetch(req, server) {
		const path = new URL(req.url).pathname;
		if (path === "/ws" && server.upgrade(req)) return;
		if (path === "/events") {
			let timer: ReturnType<typeof setTimeout>;
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("data: first\n\n"));
						timer = setTimeout(() => {
							c.enqueue(new TextEncoder().encode("data: last\n\n"));
							c.close();
						}, 2000);
					},
					cancel() {
						clearTimeout(timer);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		return new Response(payload);
	},
	websocket: {
		message(ws, message) {
			ws.send(message);
		},
	},
});
const tcp = createServer((s) => s.pipe(s));
tcp.listen(0, "127.0.0.1");
await once(tcp, "listening");
const gate = await createGate(
	(tcp.address() as { port: number }).port,
	() => true,
);
let receiver: Receiver | undefined,
	publication: PublicationLease | undefined,
	socket: ReturnType<typeof connect> | undefined;
const assert = (ok: unknown, message: string) => {
	if (!ok) throw new Error(message);
};
try {
	receiver = await request<Receiver>(origin, "/v1/receivers", undefined, {});
	const run: RunInput = {
		sessionId: crypto.randomUUID(),
		name: "Release verification",
		hostname: "release-verification",
		project: "buncargo-fixture",
		worktree: null,
		targets: [
			{
				id: "web",
				name: "web",
				kind: "app",
				protocol: "http",
				status: "ready",
				port: app.port as number,
			},
			{
				id: "tcp",
				name: "tcp",
				kind: "service",
				protocol: "tcp",
				status: "ready",
				port: (tcp.address() as { port: number }).port,
			},
		],
	};
	publication = await request<PublicationLease>(
		origin,
		"/v1/publications",
		undefined,
		{ tokens: [receiver.token], credential, run },
	);
	const web = publication.assignments.find((a) => a.protocol === "http"),
		db = publication.assignments.find((a) => a.protocol === "tcp");
	if (!web || !db) throw new Error("Relay did not allocate both targets");
	const publisher = await startFrpc({
		relay: publication.relay,
		user: publication.user,
		credential,
		proxies: [
			{
				name: web.id,
				type: "http",
				subdomain: web.subdomain,
				localIP: "127.0.0.1",
				localPort: app.port,
			},
			{
				name: db.id,
				type: "stcp",
				secretKey: db.secretKey,
				localIP: "127.0.0.1",
				localPort: Number(gate.target.split(":")[1]),
			},
		],
	});
	clients.push(publisher);
	let confirmed: string[] = [];
	for (let i = 0; i < 100; i++) {
		confirmed = runningProxies(await publisher.status());
		if (confirmed.length === 2) break;
		await abortableSleep(100);
	}
	assert(confirmed.length === 2, "Publisher could not authenticate/register");
	await request(
		origin,
		`/v1/publications/${publication.id}`,
		credential,
		{ run, confirmed },
		"PUT",
	);
	const directory = parseDirectory(
		await request(origin, "/v1/receiver/runs", receiver.owner),
		origin,
	);
	const target = directory.runs[0]?.targets.find((t) => t.protocol === "http");
	if (!target) throw new Error("Publication not discoverable");
	assert(
		directory.runs[0]?.targets.every((t) => t.status === "ready"),
		"Registered proxies must appear ready in the directory",
	);
	const start = performance.now(),
		response = await fetch(target.url, { signal: AbortSignal.timeout(30000) });
	assert(response.ok, "HTTP routing failed");
	assert(
		Buffer.from(await response.arrayBuffer()).equals(payload),
		"HTTP payload mismatch",
	);
	console.log(
		`20 MiB HTTPS transfer: ${((performance.now() - start) / 1000).toFixed(2)} seconds`,
	);
	const events = await fetch(`${target.url}events`, {
			signal: AbortSignal.timeout(10000),
		}),
		reader = events.body?.getReader();
	assert(reader, "Missing event stream");
	const first = await reader?.read();
	assert(
		first?.value && new TextDecoder().decode(first.value).includes("first"),
		"SSE first event missing",
	);
	assert(
		!new TextDecoder().decode(first?.value).includes("last"),
		"SSE was buffered",
	);
	await reader?.cancel();
	const ws = new WebSocket(`${target.url.replace(/^https:/, "wss:")}ws`);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("WebSocket timeout"));
		}, 10000);
		ws.onopen = () => ws.send("release-probe");
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("WebSocket failed"));
		};
		ws.onmessage = (e) => {
			clearTimeout(timer);
			ws.close();
			e.data === "release-probe"
				? resolve()
				: reject(new Error("WebSocket payload mismatch"));
		};
	});
	const v = await request<VisitorLease>(
			origin,
			`/v1/targets/${publication.id}.tcp/visitor`,
			receiver.owner,
			{},
		),
		port = await freePort();
	clients.push(
		await startFrpc({
			relay: v.relay,
			user: v.user,
			credential: v.credential,
			visitors: [
				{
					name: "probe",
					type: "stcp",
					serverName: v.proxyName,
					serverUser: v.user,
					secretKey: v.secretKey,
					bindAddr: "127.0.0.1",
					bindPort: port,
				},
			],
		}),
	);
	await abortableSleep(1000);
	socket = connect(port, "127.0.0.1");
	await once(socket, "connect");
	socket.write("private-probe");
	const result = await Promise.race([
		once(socket, "data"),
		abortableSleep(10000).then(() => {
			throw new Error("Private TCP timed out");
		}),
	]);
	assert(
		result[0].toString() === "private-probe",
		"Private TCP payload mismatch",
	);
	console.log(
		"Verified directory authorization, HTTPS, streamed SSE, WebSocket echo and private TCP.",
	);
} finally {
	socket?.destroy();
	await Promise.allSettled(clients.map((c) => c.close()));
	await gate.close();
	tcp.close();
	app.stop(true);
	if (publication)
		await request(
			origin,
			`/v1/publications/${publication.id}`,
			credential,
			undefined,
			"DELETE",
		).catch(() => {});
	if (receiver)
		await request(
			origin,
			"/v1/receiver",
			receiver.owner,
			undefined,
			"DELETE",
		).catch(() => {});
}
