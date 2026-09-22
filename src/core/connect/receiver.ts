import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { Connection, Endpoint } from "@number0/iroh";
import { listenLoopback } from "./endpoint";
import { denyPublisher, type ReceiverIdentity } from "./identity";
import { bindEndpoint } from "./iroh";
import {
	CONNECT_ALPN,
	type Directory,
	emptyDirectory,
	parseHello,
	parseReply,
	parseRuns,
	type RemoteRun,
	type RemoteTarget,
	type RunInput,
	STALE_MS,
	type TargetInput,
} from "./protocol";
import { bridge, MessageStream } from "./stream";

interface PublisherState {
	publisherId: string;
	hostname: string;
	runs: RunInput[];
	updatedAt: number;
	connection: Connection;
}

interface TargetRef {
	publisherId: string;
	sessionId: string;
	targetId: string;
}

interface Listener extends TargetRef {
	server: Server;
	port: number;
}

/** The address a local tool should use for a target reached through this receiver. */
function localAddress(
	target: TargetInput,
	port: number,
): { url: string; tablePlusUrl?: string } {
	if (target.protocol === "http") {
		return { url: `http://127.0.0.1:${port}/` };
	}
	if (target.tablePlusUrl) {
		const address = new URL(target.tablePlusUrl);
		address.hostname = "127.0.0.1";
		address.port = String(port);
		const url = address.toString();
		return {
			url,
			...(address.protocol === "redis:" ? {} : { tablePlusUrl: url }),
		};
	}
	const scheme =
		target.preset === "postgres"
			? "postgresql"
			: target.preset === "redis"
				? "redis"
				: "tcp";
	return { url: `${scheme}://127.0.0.1:${port}` };
}

/**
 * This computer's side of every sandbox sharing with it.
 *
 * A browser cannot dial an iroh endpoint, so each remote target gets a
 * loopback listener here and the menu hands out its `127.0.0.1` address. The
 * listener's lifetime is the run's visibility, which keeps a port stable
 * while an app restarts and releases it when the run goes away.
 */
export function createReceiver(identity: ReceiverIdentity) {
	const secret = Buffer.from(identity.secret, "hex");
	const publishers = new Map<string, PublisherState>();
	const listeners = new Map<string, Listener>();
	let denied = new Set(identity.denied);
	let endpoint: Endpoint | undefined;
	let notice: string | undefined;

	const directoryId = (state: PublisherState, run: RunInput, target: string) =>
		`${state.publisherId}.${run.sessionId}.${target}`;

	const fresh = () =>
		[...publishers.values()].filter(
			(state) => Date.now() - state.updatedAt < STALE_MS,
		);

	const drop = (id: string) => {
		const listener = listeners.get(id);
		listeners.delete(id);
		listener?.server.close();
	};

	/** Forward one local connection over the publisher's current connection. */
	const forward = async (listener: TargetRef, socket: Socket) => {
		const state = publishers.get(listener.publisherId);
		if (!state) {
			socket.destroy();
			return;
		}
		const stream = new MessageStream(await state.connection.openBi());
		try {
			await stream.send({
				type: "open",
				sessionId: listener.sessionId,
				targetId: listener.targetId,
			});
			parseReply(await stream.receive());
		} catch (error) {
			socket.destroy();
			await stream.stream.send.reset(0n).catch(() => {});
			notice = error instanceof Error ? error.message : "Connection refused";
			return;
		}
		await bridge(socket, stream);
	};

	const bind = async (listener: TargetRef): Promise<Listener> => {
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			socket.on("error", () => socket.destroy());
			void forward(listener, socket).catch(() => socket.destroy());
		});
		try {
			return { ...listener, server, port: await listenLoopback(server) };
		} catch (error) {
			server.close();
			throw error;
		}
	};

	/** Bind what is visible, release what is not. */
	const reconcile = async () => {
		const wanted = new Map<string, TargetRef>();
		for (const state of fresh()) {
			for (const run of state.runs) {
				for (const target of run.targets) {
					wanted.set(directoryId(state, run, target.id), {
						publisherId: state.publisherId,
						sessionId: run.sessionId,
						targetId: target.id,
					});
				}
			}
		}
		for (const id of [...listeners.keys()]) {
			if (!wanted.has(id)) {
				drop(id);
			}
		}
		await Promise.all(
			[...wanted].map(async ([id, listener]) => {
				if (listeners.has(id)) {
					return;
				}
				try {
					listeners.set(id, await bind(listener));
				} catch {
					notice = "Could not open a local port for a shared service";
				}
			}),
		);
	};

	const disconnect = (state: PublisherState) => {
		if (publishers.get(state.publisherId) === state) {
			publishers.delete(state.publisherId);
		}
		for (const [id, listener] of listeners) {
			if (listener.publisherId === state.publisherId) {
				drop(id);
			}
		}
		state.connection.close(0n, Array.from(Buffer.from("closed")));
	};

	const handle = async (connection: Connection) => {
		const publisherId = connection.remoteId().toString();
		if (denied.has(publisherId)) {
			connection.close(1n, Array.from(Buffer.from("revoked")));
			return;
		}
		const control = new MessageStream(await connection.acceptBi());
		const hello = parseHello(await control.receive());
		const offered = Buffer.from(hello.secret, "hex");
		if (offered.length !== secret.length || !timingSafeEqual(offered, secret)) {
			connection.close(1n, Array.from(Buffer.from("rejected")));
			return;
		}
		await control.send({ type: "ok" });

		// A reconnect replaces the old connection rather than doubling the run.
		const existing = publishers.get(publisherId);
		if (existing) {
			existing.connection.close(0n, Array.from(Buffer.from("replaced")));
			publishers.delete(publisherId);
		}
		const state: PublisherState = {
			publisherId,
			hostname: hello.hostname,
			runs: [],
			updatedAt: Date.now(),
			connection,
		};
		publishers.set(publisherId, state);
		try {
			for (;;) {
				const message = await control.receive();
				if (message === undefined || publishers.get(publisherId) !== state) {
					return;
				}
				state.runs = parseRuns(message).runs;
				state.updatedAt = Date.now();
				await reconcile();
			}
		} finally {
			disconnect(state);
			await reconcile();
		}
	};

	const accept = async (active: Endpoint) => {
		for (;;) {
			const incoming = await active.acceptNext();
			if (!incoming) {
				return;
			}
			void (async () => {
				const connection = await (await incoming.accept()).connect();
				try {
					await handle(connection);
				} catch {
					connection.close(1n, Array.from(Buffer.from("rejected")));
				}
			})().catch(() => {});
		}
	};

	return {
		async start(): Promise<void> {
			endpoint = await bindEndpoint(identity.secretKey, [CONNECT_ALPN]);
			if (endpoint.id().toString() !== identity.endpointId) {
				throw new Error("Connection identity does not match its key");
			}
			void accept(endpoint).catch(() => {});
		},

		/** Drop publishers that stopped heartbeating and release their ports. */
		async refresh(): Promise<void> {
			for (const state of publishers.values()) {
				if (Date.now() - state.updatedAt >= STALE_MS) {
					disconnect(state);
				}
			}
			await reconcile();
		},

		directory(): Directory {
			const runs: RemoteRun[] = [];
			for (const state of fresh()) {
				for (const run of state.runs) {
					const targets: RemoteTarget[] = [];
					for (const target of run.targets) {
						const listener = listeners.get(directoryId(state, run, target.id));
						if (!listener) {
							continue;
						}
						targets.push({
							...target,
							id: directoryId(state, run, target.id),
							port: listener.port,
							...localAddress(target, listener.port),
						});
					}
					// A primary app whose listener is missing would make the menu offer
					// an Open button with nothing behind it.
					const primaryApp = targets.some(
						(target) => target.name === run.primaryApp && target.kind === "app",
					)
						? run.primaryApp
						: undefined;
					runs.push({
						...run,
						publisherId: state.publisherId,
						hostname: state.hostname,
						primaryApp,
						targets,
					});
				}
			}
			return { ...emptyDirectory(notice), configured: true, runs };
		},

		/** Close a publisher out for good; it holds a valid token and would return otherwise. */
		async revoke(publisherId: string): Promise<void> {
			denied = new Set((await denyPublisher(publisherId)).denied);
			const state = publishers.get(publisherId);
			if (state) {
				disconnect(state);
			}
			await reconcile();
		},

		async close(): Promise<void> {
			for (const state of [...publishers.values()]) {
				disconnect(state);
			}
			for (const id of [...listeners.keys()]) {
				drop(id);
			}
			await endpoint?.close();
			endpoint = undefined;
		},
	};
}

export type Receiver = ReturnType<typeof createReceiver>;
