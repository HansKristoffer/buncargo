/** Exercise the production Caddy handlers on disposable loopback listeners. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "../src/core/connect/frpc";

const binary = resolve(process.argv[2] ?? "candidate-server/caddy");
const directory = await mkdtemp(join(tmpdir(), "bc-compression-"));
const source = Buffer.from(
	"// A readable source module; preserve whitespace and line numbers.\n" +
		Array.from(
			{ length: 2000 },
			(_, i) => `export const value${i} = ${i};\n`,
		).join(""),
);
const compressed = Bun.gzipSync(source);
const types: Record<string, string> = {
	"/module.js": "text/javascript; charset=utf-8",
	"/module.map": "application/json",
	"/page": "text/html",
	"/style.css": "text/css",
	"/binary": "application/octet-stream",
};
const app = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/events") {
			let timer: ReturnType<typeof setTimeout>;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: first\n\n"));
						timer = setTimeout(() => {
							controller.enqueue(new TextEncoder().encode("data: last\n\n"));
							controller.close();
						}, 2000);
					},
					cancel() {
						clearTimeout(timer);
					},
				}),
				{ headers: { "content-type": "text/event-stream; charset=utf-8" } },
			);
		}
		if (path === "/encoded") {
			return new Response(compressed, {
				headers: {
					"content-type": "text/javascript",
					"content-encoding": "gzip",
				},
			});
		}
		return new Response(source, {
			headers: { "content-type": types[path] ?? "text/plain" },
		});
	},
});
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
	const adapt = Bun.spawn(
		[
			binary,
			"adapt",
			"--config",
			"server/deploy/Caddyfile",
			"--adapter",
			"caddyfile",
		],
		{
			// Adaptation only; no certificate issuance or production credentials are needed.
			env: { ...process.env, CLOUDFLARE_API_TOKEN: "configuration-test" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [output, errors, exitCode] = await Promise.all([
		new Response(adapt.stdout).text(),
		new Response(adapt.stderr).text(),
		adapt.exited,
	]);
	assert.equal(exitCode, 0, errors);
	const config = JSON.parse(output);
	const port = await freePort();
	const server = Object.values(config.apps.http.servers)[0] as Record<
		string,
		unknown
	>;
	// Retain the real route/encoding handlers; replace only listeners, TLS, and fixture upstreams.
	server.listen = [`127.0.0.1:${port}`];
	server.automatic_https = { disable: true };
	delete server.tls_connection_policies;
	const fixture = {
		admin: { disabled: true },
		apps: { http: { servers: { test: server } } },
	};
	const path = join(directory, "caddy.json");
	await writeFile(
		path,
		JSON.stringify(fixture).replaceAll(
			"127.0.0.1:8080",
			`127.0.0.1:${app.port}`,
		),
	);
	child = Bun.spawn([binary, "run", "--config", path], {
		stdout: "ignore",
		stderr: Bun.file(join(directory, "caddy.log")),
	});
	const headers = {
		host: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.connect.hanskristoffer.dk",
	};
	const raw = (path: string, encoding: string) =>
		new Promise<{ encoding?: string; body: Buffer }>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path,
					headers: { ...headers, "accept-encoding": encoding },
					timeout: 5000,
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk) => chunks.push(chunk));
					response.on("error", reject);
					response.on("end", () =>
						resolve({
							encoding: response.headers["content-encoding"],
							body: Buffer.concat(chunks),
						}),
					);
				},
			);
			req.on("error", reject);
			req.on("timeout", () =>
				req.destroy(new Error("Caddy request timed out")),
			);
			req.end();
		});
	for (let attempt = 0; ; attempt++) {
		try {
			await raw("/module.js", "identity");
			break;
		} catch (error) {
			if (attempt === 50) throw error;
			await Bun.sleep(100);
		}
	}
	for (const encoding of ["gzip", "zstd"]) {
		for (const path of ["/module.js", "/module.map", "/page", "/style.css"]) {
			const response = await raw(path, encoding);
			assert.equal(response.encoding, encoding);
			const decoded =
				encoding === "gzip"
					? Bun.gunzipSync(Uint8Array.from(response.body))
					: Bun.zstdDecompressSync(Uint8Array.from(response.body));
			assert(
				Buffer.from(decoded).equals(source),
				"Compression changed source bytes",
			);
			assert(response.body.length < source.length / 2);
		}
	}
	for (const [path, encoding] of [
		["/module.js", "identity"],
		["/binary", "gzip, zstd"],
	]) {
		const response = await raw(path, encoding);
		assert.equal(response.encoding, undefined);
		assert(response.body.equals(source));
	}
	const encoded = await raw("/encoded", "gzip, zstd");
	assert.equal(encoded.encoding, "gzip");
	assert(
		encoded.body.equals(Buffer.from(compressed)),
		"Already encoded responses must pass through",
	);
	const start = performance.now();
	const events = await fetch(`http://127.0.0.1:${port}/events`, {
		headers: { ...headers, "accept-encoding": "gzip, zstd" },
		signal: AbortSignal.timeout(5000),
	});
	assert.equal(events.headers.get("content-encoding"), null);
	assert(events.body, "Missing SSE body");
	const reader = events.body.getReader();
	try {
		const first = await reader.read();
		assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
		assert(performance.now() - start < 1500, "SSE waited for the later event");
	} finally {
		await reader.cancel();
	}
	console.log(
		"Verified gzip/zstd, exact source bytes, identity/binary/precompressed responses, and immediate uncompressed SSE.",
	);
} finally {
	child?.kill();
	if (child) await child.exited;
	app.stop(true);
	await rm(directory, { recursive: true, force: true });
}
