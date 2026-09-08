import { expect, test } from "bun:test";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { finished } from "node:stream/promises";
import { tailcatFixture } from "../../../connect-directory/test-fixture";
import { tailcatTestsEnabled } from "../../runtime-flags";
import { localForward } from "./local-forward";

const integration = test.skipIf(!tailcatTestsEnabled());

integration(
	"Tailcat preserves 3 MB streams and TCP half-close",
	async () => {
		const server = createServer({ allowHalfOpen: true }, (s) => {
			s.on("error", () => {});
			s.pipe(s);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const f = await tailcatFixture((server.address() as { port: number }).port);
		const forward = await localForward(f.endpoint, f.target);
		try {
			const channel = connect({
				host: "127.0.0.1",
				port: forward.port,
				allowHalfOpen: true,
			});
			const chunks: Buffer[] = [];
			channel.on("data", (c) => chunks.push(Buffer.from(c)));
			const end = finished(channel);
			channel.end(Buffer.alloc(3 * 1024 * 1024, 42));
			await end;
			expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(3 * 1024 * 1024, 42));
		} finally {
			await forward.close();
			await f.stop();
			server.close();
		}
	},
	60000,
);

integration(
	"2000 module requests, incremental SSE, app authorization and WebSocket HMR",
	async () => {
		let finishEvents = () => {};
		const app = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(r, s) {
				if (r.headers.get("upgrade") === "websocket" && s.upgrade(r)) return;
				if (new URL(r.url).pathname === "/events")
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode("data: first\n\n"));
								finishEvents = () => {
									c.enqueue(new TextEncoder().encode("data: second\n\n"));
									c.close();
								};
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				return new Response(
					r.headers.get("authorization") ?? "export default 42",
				);
			},
			websocket: {
				message(ws, data) {
					ws.send(data);
				},
			},
		});
		const f = await tailcatFixture(app.port as number, "http");
		const forward = await localForward(f.endpoint, f.target);
		const concurrent = await localForward(f.endpoint, {
			...f.target,
			protocol: "tcp",
		});
		try {
			const root = `http://127.0.0.1:${forward.port}`;
			expect((await fetch(root)).status).toBe(403);
			const bootstrap = await fetch(forward.url, { redirect: "manual" });
			const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
			expect(
				(
					await fetch(root, {
						headers: { cookie, origin: "https://untrusted.example" },
					})
				).status,
			).toBe(403);
			expect(
				await (
					await fetch(root, {
						headers: { cookie, authorization: "Bearer app-token" },
					})
				).text(),
			).toBe("Bearer app-token");
			// A second client to the same publisher must not steal the first client's DERP identity.
			expect(
				await (await fetch(`http://127.0.0.1:${concurrent.port}`)).text(),
			).toBe("export default 42");
			const events = await fetch(`${root}/events`, {
				headers: { cookie },
				signal: AbortSignal.timeout(15000),
			});
			if (!events.body) throw new Error("Missing SSE body");
			const reader = events.body.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(
				"data: first\n\n",
			);
			// The origin cannot send its second event until the client sees the first.
			finishEvents();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(
				"data: second\n\n",
			);
			await reader.cancel();
			let index = 0;
			await Promise.all(
				Array.from({ length: 16 }, async () => {
					while (index < 2000) {
						const i = index++;
						const r = await fetch(`${root}/src/module-${i}.ts`, {
							headers: { cookie },
							signal: AbortSignal.timeout(15000),
						});
						expect(r.status).toBe(200);
						expect(await r.text()).toBe("export default 42");
					}
				}),
			);
			const Client = WebSocket as unknown as {
				new (url: string, options: Bun.WebSocketOptions): WebSocket;
			};
			const ws = new Client(root.replace("http:", "ws:"), {
				headers: { cookie, origin: root, "sec-websocket-protocol": "vite-hmr" },
			});
			try {
				const response = await new Promise((resolve, reject) => {
					ws.onopen = () => ws.send("hmr");
					ws.onmessage = (e) => resolve(e.data);
					ws.onerror = () => reject(new Error("HMR upgrade failed"));
				});
				expect(response).toBe("hmr");
			} finally {
				ws.close();
			}
		} finally {
			await forward.close();
			await f.stop();
			await concurrent.close();
			await app.stop(true);
		}
	},
	60000,
);

integration(
	"stopping a target closes active connections and refuses new connections",
	async () => {
		const server = createServer((s) => {
			s.on("error", () => {});
			s.pipe(s);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const f = await tailcatFixture((server.address() as { port: number }).port);
		const forward = await localForward(f.endpoint, f.target);
		const socket = connect({ host: "127.0.0.1", port: forward.port });
		socket.on("error", () => {});
		try {
			const data = once(socket, "data");
			socket.write("ready");
			expect(String((await data)[0])).toBe("ready");
			const closed = once(socket, "close");
			f.upstream.status = "stopped";
			f.publisher.disconnectTarget("target");
			await closed;
			const next = connect({ host: "127.0.0.1", port: forward.port });
			next.on("error", () => {});
			const stopped = once(next, "close");
			next.write("no access");
			await stopped;
		} finally {
			socket.destroy();
			await forward.close();
			await f.stop();
			server.close();
		}
	},
	45000,
);
