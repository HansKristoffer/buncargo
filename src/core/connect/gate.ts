import { connect, createServer } from "node:net";
import { listenEndpoint } from "./endpoint";
import { ForwardSockets } from "./sockets";

/** A byte-stream bridge enforces target lifetime; frp handles HTTP, SSE and WebSockets. */
export async function createGate(port: number, allowed: () => boolean) {
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
		target = await listenEndpoint(server);
	} catch (error) {
		server.close();
		throw error;
	}
	const sweep = setInterval(() => {
		if (!allowed()) sockets.destroy();
	}, 250);
	sweep.unref();
	const disable = () => {
		clearInterval(sweep);
		disabled = true;
		sockets.destroy();
	};
	let closing: Promise<void> | undefined;
	return {
		target,
		// Keep the listener reserved until its frpc session has ended.
		disable,
		close() {
			disable();
			closing ??= new Promise<void>((resolve) => server.close(() => resolve()));
			return closing;
		},
	};
}
