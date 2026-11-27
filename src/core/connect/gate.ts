import { connect, createServer } from "node:net";
import { listenLoopback } from "./endpoint";
import { ForwardSockets } from "./sockets";

/** A byte-stream bridge enforces target lifetime; frp handles HTTP, SSE and WebSockets. */
export async function createGate(upstreamPort: number, allowed: () => boolean) {
	const sockets = new ForwardSockets();
	let disabled = false;

	let sweep: ReturnType<typeof setInterval> | undefined;
	const stopSweepIfIdle = () => {
		if (sockets.size === 0 && sweep) {
			clearInterval(sweep);
			sweep = undefined;
		}
	};
	const ensureSweep = () => {
		if (sweep || disabled) return;
		// A connection open when the target's lease lapses is cut within a quarter
		// second, instead of living until its peer hangs up. Runs only while a
		// socket is live so an idle gate wakes zero timers.
		sweep = setInterval(() => {
			if (!allowed()) {
				sockets.destroy();
			}
			stopSweepIfIdle();
		}, 250);
		sweep.unref();
	};

	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.track(socket, stopSweepIfIdle);
		if (disabled || !allowed()) {
			socket.destroy();
			return;
		}
		ensureSweep();
		const upstream = sockets.track(
			connect({ host: "127.0.0.1", port: upstreamPort, allowHalfOpen: true }),
			stopSweepIfIdle,
		);
		sockets.bridge(socket, upstream);
	});

	let port: number;
	try {
		port = await listenLoopback(server);
	} catch (error) {
		server.close();
		throw error;
	}

	const disable = () => {
		if (sweep) {
			clearInterval(sweep);
			sweep = undefined;
		}
		disabled = true;
		sockets.destroy();
	};

	let closing: Promise<void> | undefined;
	return {
		port,
		// Keep the listener reserved until its frpc session has ended.
		disable,
		close() {
			disable();
			closing ??= new Promise<void>((resolve) => server.close(() => resolve()));
			return closing;
		},
	};
}
