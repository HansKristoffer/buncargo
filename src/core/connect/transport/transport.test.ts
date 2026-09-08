import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { finished } from "node:stream/promises";
import { importJWK, SignJWT } from "jose";
import { relayFixture } from "../../../connect-directory/test-fixture";
import { signCapability } from "../capability";
import { openStream } from "./client-stream";
import { localForward } from "./local-forward";

async function echo() {
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		socket.on("error", () => {});
		socket.pipe(socket);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { server, port: (server.address() as { port: number }).port };
}

test("relay preserves large byte streams and half-close and rejects another recipient", async () => {
	const upstream = await echo(),
		f = await relayFixture(upstream.port);
	try {
		await expect(
			openStream(f.endpoint, "target", () =>
				signCapability(
					f.directory.signingKey,
					f.client.origin,
					"other",
					f.session,
					"target",
				),
			),
		).rejects.toThrow();
		const channel = await openStream(f.endpoint, "target", f.access),
			chunks: Buffer[] = [];
		channel.on("data", (chunk) => chunks.push(chunk));
		const ended = finished(channel);
		const payload = Buffer.alloc(3 * 1024 * 1024, 42);
		channel.end(payload);
		await ended;
		expect(Buffer.concat(chunks)).toEqual(payload);
		channel.destroy();
	} finally {
		await f.stop();
		upstream.server.close();
	}
}, 15000);

test("private browser forwarding preserves app authorization, SSE and WebSocket upgrades", async () => {
	const app = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(r, s) {
			if (r.headers.get("upgrade") === "websocket" && s.upgrade(r)) return;
			return new Response(r.headers.get("authorization") ?? "hello");
		},
		websocket: {
			message(ws, data) {
				ws.send(data);
			},
		},
	});
	const f = await relayFixture(app.port as number, "http");
	const forward = await localForward(f.endpoint, f.target, f.access);
	try {
		const root = `http://127.0.0.1:${forward.port}`;
		expect((await fetch(root)).status).toBe(403);
		const bootstrap = await fetch(forward.url, { redirect: "manual" });
		expect(bootstrap.status).toBe(303);
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
		const Client = WebSocket as unknown as {
			new (url: string, options: Bun.WebSocketOptions): WebSocket;
		};
		const ws = new Client(root.replace("http:", "ws:"), {
			headers: { cookie, origin: root, "sec-websocket-protocol": "vite-hmr" },
		});
		try {
			const message = await new Promise((resolve, reject) => {
				ws.onopen = () => ws.send("hmr");
				ws.onmessage = (e) => resolve(e.data);
				ws.onerror = () => reject(new Error("Upgrade failed"));
			});
			expect(message).toBe("hmr");
		} finally {
			ws.close();
		}
	} finally {
		await forward.close();
		await f.stop();
		await app.stop(true);
	}
}, 15000);

async function shortAccess(
	f: Awaited<ReturnType<typeof relayFixture>>,
	seconds: number,
) {
	return new SignJWT({ target: "target" })
		.setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
		.setIssuer(f.client.origin)
		.setSubject(f.recipient)
		.setAudience(f.session)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
		.sign(await importJWK(f.directory.signingKey, "EdDSA"));
}

test("relay closes an active stream when authorization expires", async () => {
	const upstream = await echo(),
		f = await relayFixture(upstream.port);
	try {
		const channel = await openStream(f.endpoint, "target", () =>
			shortAccess(f, 2),
		);
		await once(channel, "close");
		expect(channel.destroyed).toBe(true);
	} finally {
		await f.stop();
		upstream.server.close();
	}
}, 5000);

test("idle streams renew authorization and remain usable beyond the first expiry", async () => {
	const upstream = await echo(),
		f = await relayFixture(upstream.port);
	let requests = 0;
	let channel: Awaited<ReturnType<typeof openStream>> | undefined;
	try {
		channel = await openStream(f.endpoint, "target", () => {
			requests++;
			return shortAccess(f, 25);
		});
		await Bun.sleep(27000);
		expect(requests).toBeGreaterThan(1);
		expect(channel.destroyed).toBe(false);
		const data = once(channel, "data");
		channel.write("still connected");
		expect(String((await data)[0])).toBe("still connected");
	} finally {
		channel?.destroy();
		await f.stop();
		upstream.server.close();
	}
}, 35000);

test("revocation closes existing streams immediately and fences future connections", async () => {
	const upstream = await echo(),
		f = await relayFixture(upstream.port);
	try {
		const channel = await openStream(f.endpoint, "target", f.access);
		const closed = once(channel, "close");
		await f.client.withdraw(f.recipient, f.session, f.owner);
		await closed;
		expect(channel.destroyed).toBe(true);
		await expect(f.access()).rejects.toThrow();
	} finally {
		await f.stop();
		upstream.server.close();
	}
}, 10000);

test("publisher reconnect closes old streams and restores readiness on the same endpoint", async () => {
	const { startRelayPublisher } = await import("./publisher");
	const upstream = await echo(),
		f = await relayFixture(upstream.port);
	let replacement: ReturnType<typeof startRelayPublisher> | undefined;
	try {
		const channel = await openStream(f.endpoint, "target", f.access);
		const closed = once(channel, "close");
		f.publisher.close();
		await closed;
		expect((await f.client.list(f.recipient, f.owner)).runs[0].transport).toBe(
			"connecting",
		);
		await expect(f.access()).rejects.toThrow();
		replacement = startRelayPublisher({
			endpoint: f.endpoint,
			secret: f.secret,
			recipient: f.recipient,
			session: f.session,
			origin: f.client.origin,
			key: f.directory.publicKey,
			targets: [f.upstream],
			signal: new AbortController().signal,
		});
		await replacement.ready;
		expect((await f.client.list(f.recipient, f.owner)).runs[0].transport).toBe(
			"ready",
		);
		const next = await openStream(f.endpoint, "target", f.access);
		const data = once(next, "data");
		next.write("new connection");
		expect(String((await data)[0])).toBe("new connection");
		next.destroy();
	} finally {
		replacement?.close();
		await f.stop();
		upstream.server.close();
	}
}, 10000);

test("a slow reader keeps buffers bounded and can resume a bulk transfer", async () => {
	const payload = Buffer.alloc(2 * 1024 * 1024, 29);
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.once("data", () => socket.end(payload));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const f = await relayFixture((server.address() as { port: number }).port);
	try {
		const channel = await openStream(f.endpoint, "target", f.access);
		channel.end("send");
		await Bun.sleep(200);
		expect(channel.destroyed).toBe(false);
		expect(channel.readableLength).toBeLessThan(1024 * 1024);
		const chunks: Buffer[] = [];
		channel.on("data", (c) => chunks.push(c));
		await once(channel, "end");
		expect(Buffer.concat(chunks)).toEqual(payload);
		channel.destroy();
	} finally {
		await f.stop();
		server.close();
	}
}, 10000);
