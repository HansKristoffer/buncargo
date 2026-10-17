/**
 * The proxy keeps a quiet streamed response open past Bun's 10s idle default.
 *
 * Opt-in because only elapsed time can prove it: Bun's idle timer cannot be
 * injected, so the case takes ~13s. Set `BUNCARGO_TEST_PROXY_IDLE=1` or run
 * `bun run test:integration-proxy-idle`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { startLocalProxy } from "./proxy";

const enabled = process.env.BUNCARGO_TEST_PROXY_IDLE === "1";

/** Comfortably past Bun's 10s default so a regression cannot pass on timing. */
const QUIET_STREAM_MS = 13_000;

describe.skipIf(!enabled)("proxy idle timeout", () => {
	const servers: Array<{ stop: () => void }> = [];

	afterEach(() => {
		for (const server of servers.splice(0)) {
			server.stop();
		}
	});

	// Bun.serve counts a streamed response with nothing to send as idle and
	// resets it mid-body at 10s. A proxy has no say in how talkative its
	// upstream is, so that default silently killed every SSE and oRPC Event
	// Iterator stream (15s keep-alive) behind a named HTTPS URL.
	it(
		"keeps a quiet streamed response open past the 10s idle default",
		async () => {
			const encoder = new TextEncoder();
			const upstream = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				// The real upstream (a dev API) opts out for the same reason;
				// leaving it on would fail the test from the far end.
				idleTimeout: 0,
				fetch() {
					return new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(encoder.encode(": open\n\n"));
								await Bun.sleep(QUIET_STREAM_MS);
								controller.enqueue(encoder.encode("data: late\n\n"));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			servers.push(upstream);

			const routes = new Map([["api.serpier.localhost", upstream.port]]);
			const proxy = await startLocalProxy({
				lookup: (hostname) => routes.get(hostname),
				routes: () => ({
					hostnames: [...routes.keys()],
					lastReloadAt: Date.now(),
				}),
				httpsPort: 0,
				hostname: "127.0.0.1",
			});
			servers.push(proxy);

			const response = await fetch(`http://127.0.0.1:${proxy.httpsPort}/sse`, {
				headers: { host: "api.serpier.localhost" },
			});
			expect(response.status).toBe(200);

			// A reset surfaces as a read rejection, not a short body, so let it
			// throw: the failure message is more useful than an empty string.
			expect(await response.text()).toContain("data: late");
		},
		QUIET_STREAM_MS + 20_000,
	);
});
