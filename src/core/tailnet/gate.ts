import { once } from "node:events";
import { rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { ForwardSockets } from "./sockets";

/** Unix endpoints cannot accidentally forward to an unrelated process reusing a dead daemon's TCP port.
 * Tailscale Serve owns HTTP/TLS, SSE and WebSocket proxying; this bridge only enforces target lifetime.
 */
export async function createGate(
	path: string,
	port: number,
	allowed: () => boolean,
) {
	const sockets = new ForwardSockets();
	let closed = false;
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.track(socket);
		if (closed || !allowed()) {
			socket.destroy();
			return;
		}
		const upstream = sockets.track(
			connect({ host: "127.0.0.1", port, allowHalfOpen: true }),
		);
		sockets.bridge(socket, upstream);
	});
	try {
		const listening = once(server, "listening");
		server.listen(path);
		await listening;
	} catch (error) {
		server.close();
		throw error;
	}
	return {
		target: `unix:${path}`,
		async close() {
			if (closed) return;
			closed = true;
			sockets.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(path, { force: true });
		},
	};
}
