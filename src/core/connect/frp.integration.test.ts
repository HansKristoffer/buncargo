import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionDirectory } from "../../../server/connect/directory";
import { frpHook } from "../../../server/connect/http";
import { Store } from "../../../server/connect/store";
import { abortableSleep } from "../deadline";
import { frpTestsEnabled } from "../runtime-flags";
import { installFrp } from "./binary";
import { newCredential } from "./credentials";
import { type Frpc, freePort, runningProxies, startFrpc } from "./frpc";
import { createGate } from "./gate";

const integration = frpTestsEnabled() ? test : test.skip;

integration(
	"real frps: TLS, plugin admission, hostname HTTP/SSE/WebSocket, private TCP and stream revocation",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "bc-frp-integration-"));
		const key = join(dir, "key.pem");
		const cert = join(dir, "cert.pem");
		const openssl = Bun.spawn(
			[
				"openssl",
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		expect(await openssl.exited).toBe(0);
		const control = await freePort();
		const http = await freePort();
		const store = new Store(":memory:", Buffer.alloc(32, 2));
		const d = new ConnectionDirectory(store, "https://connect.test", {
			host: "localhost",
			port: control,
			serverName: "localhost",
		});
		const hook = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				return Response.json(
					frpHook(
						d,
						new URL(req.url).searchParams.get("op") ?? "",
						await req.json(),
					),
				);
			},
		});
		const origin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch(req, s) {
				if (new URL(req.url).pathname === "/ws" && s.upgrade(req)) {
					return;
				}
				if (new URL(req.url).pathname === "/events") {
					let timer: ReturnType<typeof setTimeout>;
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode("data: first\n\n"));
								timer = setTimeout(() => {
									c.enqueue(new TextEncoder().encode("data: last\n\n"));
									c.close();
								}, 1000);
							},
							cancel() {
								clearTimeout(timer);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}

				return new Response(`module:${"x".repeat(1024 * 1024)}`);
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
		let allowed = true;
		const gate = await createGate(
			(tcp.address() as { port: number }).port,
			() => allowed,
		);
		const owner = d.createReceiver();
		const credential = newCredential("pub");
		const run = {
			sessionId: "fixture",
			name: "Cursor",
			hostname: "fixture",
			project: "test",
			worktree: null,
			targets: [
				{
					id: "app",
					name: "app",
					kind: "app",
					protocol: "http",
					status: "ready",
					port: origin.port,
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
		const p = d.register([owner.token], run, credential);
		const httpAssignment = p.assignments.find((a) => a.protocol === "http");
		const tcpAssignment = p.assignments.find((a) => a.protocol === "tcp");
		if (!httpAssignment || !tcpAssignment) {
			throw new Error("Missing assignments");
		}
		const config = join(dir, "frps.json");
		await writeFile(
			config,
			JSON.stringify({
				bindAddr: "127.0.0.1",
				bindPort: control,
				proxyBindAddr: "127.0.0.1",
				vhostHTTPPort: http,
				subDomainHost: "connect.test",
				transport: { tls: { force: true, certFile: cert, keyFile: key } },
				auth: {
					method: "token",
					token: "",
					additionalScopes: ["HeartBeats", "NewWorkConns"],
				},
				httpPlugins: [
					{
						name: "connect",
						addr: `127.0.0.1:${hook.port}`,
						path: "/",
						ops: ["Login", "NewProxy", "Ping", "NewWorkConn"],
					},
				],
			}),
		);
		const log = join(dir, "frps.log");
		const frps = Bun.spawn([await installFrp("frps"), "-c", config], {
			stdout: Bun.file(log),
			stderr: Bun.file(log),
		});
		const clients: Frpc[] = [];
		let socket: ReturnType<typeof connect> | undefined;
		try {
			const ca = await readFile(cert, "utf8");
			const publisher = await startFrpc(
				{
					relay: p.relay,
					user: p.user,
					credential,
					proxies: [
						{
							name: httpAssignment.id,
							type: "http",
							subdomain: httpAssignment.subdomain,
							localIP: "127.0.0.1",
							localPort: origin.port,
						},
						{
							name: tcpAssignment.id,
							type: "stcp",
							secretKey: tcpAssignment.secretKey,
							localIP: "127.0.0.1",
							localPort: gate.port,
						},
					],
				},
				undefined,
				ca,
			);
			clients.push(publisher);
			let running: string[] = [];
			for (let i = 0; i < 100; i++) {
				running = runningProxies(await publisher.status());
				if (running.length === 2) {
					break;
				}
				await abortableSleep(100);
			}
			expect(running.length).toBe(2);
			d.update(p.id, credential, run, running);
			expect(d.list(owner.owner).runs[0]?.targets.map((t) => t.status)).toEqual(
				["ready", "ready"],
			);
			const host = `${httpAssignment.subdomain}.connect.test`;
			const get = (path: string) =>
				new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
					const r = httpRequest(
						{ host: "127.0.0.1", port: http, path, headers: { host } },
						resolve,
					);
					r.on("error", reject);
					r.end();
				});
			const response = await get("/src/routes/$.ts");
			expect(response.statusCode).toBe(200);
			const chunks: Buffer[] = [];
			for await (const c of response) {
				chunks.push(c);
			}
			expect(Buffer.concat(chunks).length).toBe(1024 * 1024 + 7);
			const start = Date.now();
			const events = await get("/events");
			await once(events, "data");
			expect(Date.now() - start).toBeLessThan(900);
			events.destroy();
			// Bun WebSocket supports Host overrides for this local wildcard fixture.
			const ClientWebSocket = globalThis.WebSocket as unknown as new (
				url: string,
				options: { headers: Record<string, string> },
			) => WebSocket;
			const ws = new ClientWebSocket(`ws://127.0.0.1:${http}/ws`, {
				headers: { Host: host },
			});
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => ws.send("echo");
				ws.onmessage = (e) => {
					expect(e.data).toBe("echo");
					ws.close();
					resolve();
				};
				ws.onerror = () => reject(new Error("WebSocket failed"));
			});
			const v = d.visitor(owner.owner, `${p.id}.tcp`);
			const port = await freePort();
			const visitor = await startFrpc(
				{
					relay: v.relay,
					user: v.user,
					credential: v.credential,
					visitors: [
						{
							name: "visitor",
							type: "stcp",
							serverName: v.proxyName,
							serverUser: v.user,
							secretKey: v.secretKey,
							bindAddr: "127.0.0.1",
							bindPort: port,
						},
					],
				},
				undefined,
				ca,
			);
			clients.push(visitor);
			await abortableSleep(500);
			socket = connect(port, "127.0.0.1");
			socket.on("error", () => {});
			await once(socket, "connect");
			socket.write("private");
			expect((await once(socket, "data"))[0].toString()).toBe("private");
			await publisher.reload([
				{
					name: tcpAssignment.id,
					type: "stcp",
					secretKey: tcpAssignment.secretKey,
					localIP: "127.0.0.1",
					localPort: gate.port,
				},
			]);
			// Removing another route must preserve this already-open TCP connection.
			socket.write("after-reload");
			expect((await once(socket, "data"))[0].toString()).toBe("after-reload");
			const closed = once(socket, "close");
			d.revoke(owner.owner, p.id);
			allowed = false;
			await closed;
			expect(() => d.renewVisitor(v.credential)).toThrow();
			const unauthorized = await startFrpc(
				{
					relay: p.relay,
					user: p.user,
					credential: newCredential("pub"),
					proxies: [
						{
							name: "stolen",
							type: "http",
							subdomain: "stolen",
							localPort: origin.port,
						},
					],
				},
				undefined,
				ca,
			);
			clients.push(unauthorized);
			await abortableSleep(500);
			expect(runningProxies(await unauthorized.status())).toEqual([]);
		} catch (e) {
			console.error(await readFile(log, "utf8"));
			throw e;
		} finally {
			socket?.destroy();
			await Promise.all(clients.map((c) => c.close()));
			await gate.close();
			tcp.close();
			origin.stop(true);
			hook.stop(true);
			frps.kill();
			await frps.exited;
			store.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
	60000,
);
