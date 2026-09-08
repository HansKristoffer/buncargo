import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { sleep } from "../../sleep";
import { connectorEndpoint } from "../protocol";
import type { SharedTarget } from "../targets";
import { startTailcat } from "./process";
export interface TailcatPublisher {
	endpoint: string;
	targets: SharedTarget[];
	exited: Promise<void>;
	disconnectTarget(id: string): void;
	close(): Promise<void>;
}
/** Gates keep stopped targets closed even if an unrelated process later reuses their app port. */
export async function startTailcatPublisher(options: {
	targets: SharedTarget[];
	signal: AbortSignal;
}): Promise<TailcatPublisher> {
	if (!options.targets.length) throw new Error("Invalid Tailcat publisher");
	const gates: {
		server: ReturnType<typeof createServer>;
		sockets: Set<Socket>;
		id: string;
	}[] = [];
	const exposed: SharedTarget[] = [];
	let child: Awaited<ReturnType<typeof startTailcat<string>>> | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			for (const gate of gates) {
				for (const socket of gate.sockets) socket.destroy();
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
			if (
				!Number.isInteger(target.port) ||
				target.port < 1 ||
				target.port > 65535
			)
				throw new Error("Invalid shared port");
			const sockets = new Set<Socket>();
			const track = (socket: Socket) => {
				sockets.add(socket);
				socket.on("error", () => {});
				socket.on("close", () => sockets.delete(socket));
			};
			const server = createServer({ allowHalfOpen: true }, (socket) => {
				track(socket);
				if (closing || !["ready", "reused"].includes(target.status)) {
					socket.destroy();
					return;
				}
				const upstream = connect({
					host: "127.0.0.1",
					port: target.port,
					allowHalfOpen: true,
				});
				track(upstream);
				socket.on("close", () => upstream.destroy());
				upstream.on("close", () => socket.destroy());
				socket.pipe(upstream).pipe(socket);
			});
			gates.push({ server, sockets, id: target.id });
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			exposed.push({
				...target,
				port: (server.address() as { port: number }).port,
			});
		}
		child = await startTailcat(
			[
				"--json",
				"--key=new",
				"serve",
				"--psk=true",
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
				for (const gate of gates)
					if (gate.id === id) for (const s of gate.sockets) s.destroy();
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
