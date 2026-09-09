import { once } from "node:events";
import type { AddressInfo, Server } from "node:net";

/** Loopback works with both unprivileged Linux Serve and the sandboxed macOS app.
 * Unix backend targets require local-admin permission even for a userspace daemon.
 * The daemon's private Unix control socket is independent of these backend listeners.
 */
export async function listenEndpoint(server: Server) {
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function serveTarget(endpoint: string, protocol: "http" | "tcp") {
	return protocol === "http" ? `http://${endpoint}` : endpoint;
}
