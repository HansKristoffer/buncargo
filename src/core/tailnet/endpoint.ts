import { once } from "node:events";
import type { AddressInfo, Server } from "node:net";

/** The macOS network extension permits loopback TCP but denies Unix socket connections.
 * Linux keeps private Unix sockets. Remote access uses temporary Serve routes on both platforms.
 */
export async function listenEndpoint(
	server: Server,
	path: string,
	platform = process.platform,
) {
	const listening = once(server, "listening");
	if (platform === "darwin") server.listen(0, "127.0.0.1");
	else server.listen(path);
	await listening;
	return platform === "darwin"
		? `127.0.0.1:${(server.address() as AddressInfo).port}`
		: `unix:${path}`;
}

export function serveTarget(endpoint: string, protocol: "http" | "tcp") {
	return protocol === "http" && !endpoint.startsWith("unix:")
		? `http://${endpoint}`
		: endpoint;
}
