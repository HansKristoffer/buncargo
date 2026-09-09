import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate } from "./gate";

test("TCP half-close returns the complete response; closing one gate preserves another's stream", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-gate-"));
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
	const a = await createGate(join(dir, "a.sock"), port, () => true, "linux"),
		b = await createGate(join(dir, "b.sock"), port, () => true, "linux");
	const first = connect(join(dir, "a.sock")),
		second = connect(join(dir, "b.sock"));
	try {
		await Promise.all([once(first, "connect"), once(second, "connect")]);
		const closed = once(first, "close");
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
		await rm(dir, { recursive: true, force: true });
	}
});

test("HTTP headers and SSE arrive before the response completes; denied gates never reach the service", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-sse-"));
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
	const gate = await createGate(
		join(dir, "http.sock"),
		port,
		() => allowed,
		"linux",
	);
	const req = request({ socketPath: join(dir, "http.sock"), path: "/events" });
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
		const denied = connect(join(dir, "http.sock"));
		denied.on("error", () => {});
		await once(denied, "close");
		expect(requests).toBe(1);
	} finally {
		req.destroy();
		await gate.close();
		upstream.closeAllConnections();
		upstream.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("Mac loopback gates stream bytes and hold their port while disabled", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bc-mac-gate-"));
	const unusedPath = join(directory, "unused.sock");
	await writeFile(unusedPath, "not owned by the TCP gate");
	const upstream = createServer((socket) => socket.pipe(socket));
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const gate = await createGate(
		unusedPath,
		(upstream.address() as { port: number }).port,
		() => true,
		"darwin",
	);
	const port = Number(gate.target.split(":")[1]);
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
		expect(await readFile(unusedPath, "utf8")).toBe(
			"not owned by the TCP gate",
		);
	} finally {
		socket.destroy();
		await gate.close();
		upstream.close();
		await rm(directory, { recursive: true, force: true });
	}
});
