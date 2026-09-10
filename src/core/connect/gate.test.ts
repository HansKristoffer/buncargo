import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer as httpServer, request } from "node:http";
import { connect, createServer } from "node:net";
import { createGate } from "./gate";

test("TCP half-close returns the complete response; closing one gate preserves another's stream", async () => {
	const upstream = createServer({ allowHalfOpen: true }, (socket) => {
		let body = "";
		socket.on("data", (chunk) => {
			body += chunk;
		});
		socket.on("end", () => socket.end(`reply:${body}`));
	});
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const port = (upstream.address() as { port: number }).port;
	const a = await createGate(port, () => true);
	const b = await createGate(port, () => true);
	const first = connect(a.port, "127.0.0.1");
	const second = connect(b.port, "127.0.0.1");
	try {
		await Promise.all([once(first, "connect"), once(second, "connect")]);
		// TCP may reset a stream whose upstream connect is still in flight.
		first.on("error", () => {});
		const closed = new Promise<void>((resolve) =>
			first.once("close", () => resolve()),
		);
		await a.close();
		await closed;
		let result = "";
		second.on("data", (chunk) => {
			result += chunk;
		});
		const ended = once(second, "end");
		second.end("payload");
		await ended;
		expect(result).toBe("reply:payload");
	} finally {
		first.destroy();
		second.destroy();
		await a.close();
		await b.close();
		upstream.close();
	}
});

test("HTTP headers and SSE arrive before the response completes; denied gates never reach the service", async () => {
	let requests = 0;
	const upstream = httpServer((_req, res) => {
		requests++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: first\n\n");
	});
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const port = (upstream.address() as { port: number }).port;
	let allowed = true;
	const gate = await createGate(port, () => allowed);
	const req = request(`http://127.0.0.1:${gate.port}/events`);
	try {
		const response = new Promise<string>((resolve, reject) => {
			req.on("response", (res) =>
				res.once("data", (chunk) => resolve(String(chunk))),
			);
			req.on("error", reject);
		});
		req.end();
		expect(await response).toBe("data: first\n\n");
		allowed = false;
		const denied = connect(gate.port, "127.0.0.1");
		denied.on("error", () => {});
		await once(denied, "close");
		expect(requests).toBe(1);
	} finally {
		req.destroy();
		await gate.close();
		upstream.closeAllConnections();
		upstream.close();
	}
});

test("Loopback gates stream bytes and hold their port while disabled", async () => {
	const upstream = createServer((socket) => socket.pipe(socket));
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const gate = await createGate(
		(upstream.address() as { port: number }).port,
		() => true,
	);
	const port = gate.port;
	const socket = connect(port, "127.0.0.1");
	try {
		await once(socket, "connect");
		const reply = once(socket, "data");
		socket.write("mac-forwarding");
		expect(String((await reply)[0])).toBe("mac-forwarding");
		const closed = once(socket, "close");
		gate.disable();
		await closed;
		const denied = connect(port, "127.0.0.1");
		denied.on("error", () => {});
		await once(denied, "close");
		await Promise.all([gate.close(), gate.close()]);
	} finally {
		socket.destroy();
		await gate.close();
		upstream.close();
	}
});
