import { rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { listenEndpoint } from "./endpoint";
import { ForwardSockets } from "./sockets";

/** A byte-stream bridge enforces target lifetime; Serve handles HTTP, SSE and WebSockets. */
export async function createGate(
	path: string,
	port: number,
	allowed: () => boolean,
	platform = process.platform,
) {
	const sockets = new ForwardSockets();
	let disabled = false;
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.track(socket);
		if (disabled || !allowed()) {
			socket.destroy();
			return;
		}
		const upstream = sockets.track(
			connect({ host: "127.0.0.1", port, allowHalfOpen: true }),
		);
		sockets.bridge(socket, upstream);
	});
	let target: string;
	try {
		target = await listenEndpoint(server, path, platform);
	} catch (error) {
		server.close();
		throw error;
	}
	const disable = () => {
		disabled = true;
		sockets.destroy();
	};
	let closing: Promise<void> | undefined;
	return {
		target,
		// Keep the listener reserved until its Serve session has ended.
		disable,
		close() {
			disable();
			closing ??= (async () => {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				if (target.startsWith("unix:")) await rm(path, { force: true });
			})();
			return closing;
		},
	};
}
