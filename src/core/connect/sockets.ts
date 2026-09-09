import type { Duplex } from "node:stream";

/** Own both sides of a forward so teardown also closes idle and upgraded sockets. */
export class ForwardSockets {
	private readonly sockets = new Set<Duplex>();

	track<T extends Duplex>(socket: T): T {
		this.sockets.add(socket);
		// Connection failures are handled by closing the pair, not process-wide errors.
		socket.on("error", () => socket.destroy());
		socket.once("close", () => this.sockets.delete(socket));
		return socket;
	}

	/** Pipe with backpressure; only a full close destroys the peer, preserving TCP half-close. */
	bridge(downstream: Duplex, upstream: Duplex): void {
		if (downstream.destroyed || upstream.destroyed) {
			downstream.destroy();
			upstream.destroy();
			return;
		}
		downstream.once("close", () => upstream.destroy());
		upstream.once("close", () => downstream.destroy());
		downstream.pipe(upstream).pipe(downstream);
	}

	destroy(): void {
		for (const socket of this.sockets) {
			socket.destroy();
		}
	}
}
