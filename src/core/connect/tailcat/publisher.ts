import { connect, createServer } from "node:net";
import { sleep } from "../../sleep";
import {
	connectorEndpoint,
	isTargetReady,
	type RemoteTarget,
	validPort,
} from "../protocol";
import { ForwardSockets, listenLoopback } from "../transport/sockets";
import { startTailcat } from "./process";
export interface TailcatPublisher {
	endpoint: string;
	targets: RemoteTarget[];
	exited: Promise<void>;
	disconnectTarget(id: string): void;
	close(): Promise<void>;
}
/** Gates keep stopped targets closed even if an unrelated process later reuses their app port. */
export async function startTailcatPublisher(options: {
	targets: RemoteTarget[];
	signal: AbortSignal;
}): Promise<TailcatPublisher> {
	if (!options.targets.length) throw new Error("Invalid Tailcat publisher");
	const gates: {
		server: ReturnType<typeof createServer>;
		sockets: ForwardSockets;
		id: string;
	}[] = [];
	const exposed: RemoteTarget[] = [];
	let child: Awaited<ReturnType<typeof startTailcat<string>>> | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			for (const gate of gates) {
				gate.sockets.destroy();
				gate.server.close();
			}
			// Let TCP close frames leave the userspace stack before stopping its process.
			if (child) await sleep(1000);
			await child?.close();
		})();
		return closing;
	};
	try {
		for (const target of options.targets) {
			if (!validPort(target.port)) throw new Error("Invalid shared port");
			options.signal.throwIfAborted();
			const sockets = new ForwardSockets();
			const server = createServer({ allowHalfOpen: true }, (socket) => {
				sockets.track(socket);
				if (closing || !isTargetReady(target)) {
					socket.destroy();
					return;
				}
				const upstream = connect({
					host: "127.0.0.1",
					port: target.port,
					allowHalfOpen: true,
				});
				sockets.track(upstream);
				sockets.bridge(socket, upstream);
			});
			gates.push({ server, sockets, id: target.id });
			const port = await listenLoopback(server);
			exposed.push({
				...target,
				port,
			});
		}
		child = await startTailcat(
			[
				"--json",
				"--key=new",
				"serve",
				"--psk=true",
				// Recipients learn the relay from discovery, without fetching the publisher's map.
				"--full-address",
				exposed.map((t) => t.port).join(","),
			],
			(line) => {
				if (!line.startsWith("{")) return;
				return connectorEndpoint(JSON.parse(line).listenAddr);
			},
			options.signal,
		);
		void child.exited.then(close).catch(() => {});
		return {
			endpoint: child.value,
			targets: exposed,
			exited: child.exited,
			close,
			disconnectTarget(id) {
				for (const gate of gates) if (gate.id === id) gate.sockets.destroy();
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
