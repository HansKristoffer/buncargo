import { CONNECT_ORIGIN } from "../../src/core/connect/origin";
import { ConnectionDirectory } from "./directory";
import { createAPI, frpHook } from "./http";
import { Store } from "./store";

// Operator variables use CONNECT_*; BUNCARGO_* remains the CLI's runtime-flags surface.
const origin = process.env.CONNECT_ORIGIN ?? CONNECT_ORIGIN;

const key = process.env.CONNECT_STORAGE_KEY ?? "";

// AES-256-GCM needs exactly 32 bytes, written as 64 hex characters.
if (!/^[a-f0-9]{64}$/.test(key)) {
	throw new Error("Set CONNECT_STORAGE_KEY to a persistent 32-byte hex key");
}

const store = new Store(
	process.env.CONNECT_DATABASE ?? "/var/lib/buncargo-connect/directory.sqlite",
	Buffer.from(key, "hex"),
);

// Port 7000 is the frps bind port that smoke.sh checks.
const directory = new ConnectionDirectory(store, origin, {
	host: new URL(origin).hostname,
	port: 7000,
	serverName: new URL(origin).hostname,
});

// A restart expires every publication lease and drops visitor grants. Publishers revive
// theirs on their next renewal.
directory.invalidateLeases();

const api = createAPI(directory);

// The public API (Caddy proxies connect.* here) and the frps plugin hook below listen on
// loopback only. The 128 KiB body limit matches MAX_REQUEST_BYTES in http.ts.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 8081,
	maxRequestBodySize: 131072,
	fetch: (req, s) =>
		api(req, req.headers.get("x-real-ip") ?? s.requestIP(req)?.address),
});

const hook = Bun.serve({
	hostname: "127.0.0.1",
	port: 8082,
	maxRequestBodySize: 131072,
	async fetch(req) {
		if (req.method !== "POST") {
			return new Response(null, { status: 405 });
		}
		try {
			return Response.json(
				frpHook(
					directory,
					new URL(req.url).searchParams.get("op") ?? "",
					await req.json(),
				),
			);
		} catch {
			return Response.json({ reject: true, reject_reason: "Invalid request" });
		}
	},
});

const gc = setInterval(() => directory.collect(), 60_000);

function stop() {
	clearInterval(gc);
	server.stop(true);
	hook.stop(true);
	store.close();
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
