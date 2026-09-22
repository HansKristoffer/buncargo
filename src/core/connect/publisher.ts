import { once } from "node:events";
import { connect as connectSocket, type Socket } from "node:net";
import type { Connection, Endpoint } from "@number0/iroh";
import { matchesProcessIdentity } from "../process-identity";
import { alpnBytes, endpointAddr } from "./iroh";
import {
	CONNECT_ALPN,
	type ConnectToken,
	parseOpen,
	parseReply,
	type RunInput,
	ready,
} from "./protocol";
import { bridge, MessageStream } from "./stream";
import type { LocalTarget } from "./targets";

/** A run as this computer sees it: what to publish, and what that maps to locally. */
export interface PublishedRun {
	input: RunInput;
	targets: LocalTarget[];
}

const MAX_BACKOFF_MS = 30_000;

/**
 * This computer's side of one receiver.
 *
 * One connection carries every run shared with that receiver: QUIC gives each
 * stream its own flow control, so a stalled database client cannot hold up an
 * app's page load, and a second worktree costs a stream rather than a dial.
 */
export function createPublisher(options: {
	endpoint: Endpoint;
	token: ConnectToken;
	name: string;
	hostname: string;
}) {
	const { endpoint, token } = options;
	let connection: Connection | undefined;
	let control: MessageStream | undefined;
	let runs: PublishedRun[] = [];
	let failures = 0;
	let nextAttempt = 0;
	let lastError: unknown;
	const sockets = new Map<string, Set<Socket>>();

	const key = (sessionId: string, targetId: string) =>
		`${sessionId}\u0000${targetId}`;

	const track = (id: string, socket: Socket) => {
		let set = sockets.get(id);
		if (!set) {
			set = new Set();
			sockets.set(id, set);
		}
		set.add(socket);
		socket.once("close", () => {
			set?.delete(socket);
			if (!set?.size) {
				sockets.delete(id);
			}
		});
	};

	const closeStreams = (id: string) => {
		for (const socket of sockets.get(id) ?? []) {
			socket.destroy();
		}
		sockets.delete(id);
	};

	/** The registry is the authority: a target whose process was replaced is not this target. */
	const resolve = (sessionId: string, targetId: string): LocalTarget => {
		const run = runs.find((entry) => entry.input.sessionId === sessionId);
		const target = run?.targets.find((entry) => entry.id === targetId);
		if (!target || !ready(target.status)) {
			throw new Error("Target is not running");
		}
		if (
			target.pid &&
			!matchesProcessIdentity(target.pid, target.processIdentity)
		) {
			throw new Error("Target was replaced");
		}
		return target;
	};

	const serve = async (stream: MessageStream) => {
		const request = parseOpen(await stream.receive());
		let socket: Socket | undefined;
		try {
			const target = resolve(request.sessionId, request.targetId);
			socket = connectSocket({
				host: "127.0.0.1",
				port: target.port,
				allowHalfOpen: true,
			});
			await once(socket, "connect");
			track(key(request.sessionId, request.targetId), socket);
			await stream.send({ type: "ok" });
		} catch (error) {
			socket?.destroy();
			await stream
				.send({
					type: "error",
					message:
						error instanceof Error ? error.message : "Target unavailable",
				})
				.catch(() => {});
			await stream.stream.send.finish().catch(() => {});
			return;
		}
		await bridge(socket, stream);
	};

	/** Receiver-opened streams arrive for the life of the connection; one failure is one stream. */
	const accept = async (active: Connection) => {
		for (;;) {
			const stream = await active.acceptBi();
			void serve(new MessageStream(stream)).catch(() => {});
		}
	};

	const open = async () => {
		const active = await endpoint.connect(
			endpointAddr(token.endpointId),
			alpnBytes(CONNECT_ALPN),
		);
		const stream = new MessageStream(await active.openBi());
		await stream.send({
			type: "hello",
			secret: token.secret,
			name: options.name,
			hostname: options.hostname,
		});
		parseReply(await stream.receive());
		connection = active;
		control = stream;
		void accept(active).catch(() => {});
		// A closed connection must not keep publishing into a dead stream.
		void active.closed().then(() => {
			if (connection === active) {
				connection = undefined;
				control = undefined;
			}
		});
	};

	return {
		/** Publish the current runs, connecting or reconnecting when needed. */
		async update(next: PublishedRun[]): Promise<void> {
			const live = new Set(
				next.flatMap((run) =>
					run.targets.map((target) => key(run.input.sessionId, target.id)),
				),
			);
			const ports = new Map(
				next.flatMap((run) =>
					run.targets.map(
						(target) =>
							[key(run.input.sessionId, target.id), target.port] as const,
					),
				),
			);
			const previous = runs;
			runs = next;
			// Close first: a retired or moved target must stop carrying bytes before
			// the receiver is told it is gone.
			for (const run of previous) {
				for (const target of run.targets) {
					const id = key(run.input.sessionId, target.id);
					if (!live.has(id) || ports.get(id) !== target.port) {
						closeStreams(id);
					}
				}
			}

			if (!connection) {
				if (performance.now() < nextAttempt) {
					throw lastError;
				}
				try {
					await open();
					failures = 0;
				} catch (error) {
					lastError = error;
					const delay = Math.min(
						MAX_BACKOFF_MS,
						1000 * 2 ** Math.min(failures++, 5),
					);
					nextAttempt = performance.now() + delay * (0.8 + Math.random() * 0.2);
					throw error;
				}
			}
			// Never resolve having published nothing: the connection can close
			// between the dial and this write, and a caller reading success would
			// report a sandbox as shared when its receiver had closed it out.
			if (!control) {
				throw new Error("Sharing connection closed");
			}
			await control.send({
				type: "runs",
				runs: next.map((run) => run.input),
			});
		},

		async close(): Promise<void> {
			for (const id of [...sockets.keys()]) {
				closeStreams(id);
			}
			connection?.close(0n, Array.from(Buffer.from("stopped")));
			connection = undefined;
			control = undefined;
		},
	};
}

export type Publisher = ReturnType<typeof createPublisher>;
