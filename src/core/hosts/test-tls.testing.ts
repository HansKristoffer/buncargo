import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A self-signed pair for `localhost`, `*.localhost`, `127.0.0.1` and `::1`,
 * valid for a century, so tests bind the proxy the one way the daemon does:
 * over TLS.
 */
export const TEST_TLS = {
	cert: readFileSync(join(import.meta.dir, "fixtures/proxy-test.pem"), "utf-8"),
	key: readFileSync(
		join(import.meta.dir, "fixtures/proxy-test-key.pem"),
		"utf-8",
	),
};

/** What `fetch` and `WebSocket` take to accept {@link TEST_TLS}. */
export const ACCEPT_TEST_TLS = { tls: { rejectUnauthorized: false } };
