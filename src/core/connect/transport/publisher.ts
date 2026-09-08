import { createConnection, type Socket } from "node:net";
import type { JWK } from "jose";
import { verifyCapability } from "../capability";
import { identifier, type TargetStatus } from "../protocol";
import { Channel } from "./channel";
export interface Upstream {
	id: string;
	port: number;
	status: TargetStatus;
}
export interface RelayPublisher {
	ready: Promise<void>;
	exited: Promise<void>;
	close(): void;
	disconnectTarget(id: string): void;
}
const ClientSocket = WebSocket as unknown as {
	new (url: URL, options: Bun.WebSocketOptions): WebSocket;
};
function address(endpoint: string, path: string) {
	const url = new URL(`${endpoint}/${path}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url;
}
/** The publisher dials out to the same stable relay origin as recipients. */
export function startRelayPublisher(options: {
	endpoint: string;
	secret: string;
	recipient: string;
	session: string;
	origin: string;
	key: JWK;
	targets: Upstream[];
	signal: AbortSignal;
}): RelayPublisher {
	let resolveReady: () => void = () => {},
		rejectReady: (error: Error) => void = () => {},
		resolveExit: () => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	const control = new ClientSocket(address(options.endpoint, "publisher"), {
		headers: { authorization: `Bearer ${options.secret}` },
	});
	let stopped = false,
		seen = Date.now();
	const streams = new Map<
		string,
		{
			target: string;
			ws?: WebSocket;
			channel?: Channel;
			tcp?: Socket;
			timer?: ReturnType<typeof setTimeout>;
		}
	>();
	function closeStream(id: string) {
		const s = streams.get(id);
		if (!s) return;
		streams.delete(id);
		if (s.timer) clearTimeout(s.timer);
		s.ws?.close();
		s.channel?.destroy();
		s.tcp?.destroy();
	}
	const startup = setTimeout(() => {
		rejectReady(new Error("Relay connection timed out"));
		close();
	}, 10000);
	const heartbeat = setInterval(() => {
		if (Date.now() - seen > 45000) {
			close();
			return;
		}
		if (control.readyState === WebSocket.OPEN) control.send("ping");
	}, 15000);
	function close() {
		if (stopped) return;
		stopped = true;
		clearTimeout(startup);
		clearInterval(heartbeat);
		options.signal.removeEventListener("abort", close);
		control.close();
		for (const id of streams.keys()) closeStream(id);
		rejectReady(new Error("Relay disconnected"));
		resolveExit();
	}
	async function open(message: Record<string, unknown>) {
		const { id, target, capability } = message;
		if (
			!identifier(id) ||
			!identifier(target) ||
			typeof capability !== "string" ||
			capability.length > 8192 ||
			streams.has(id) ||
			streams.size >= 64
		)
			return;
		const upstream = options.targets.find((t) => t.id === target);
		if (!upstream || !["ready", "reused"].includes(upstream.status)) return;
		const stream: {
			target: string;
			ws?: WebSocket;
			channel?: Channel;
			tcp?: Socket;
			timer?: ReturnType<typeof setTimeout>;
		} = { target };
		streams.set(id, stream);
		try {
			const access = await verifyCapability(
				capability,
				options.key,
				options.origin,
				options.session,
				target,
			);
			if (access.recipient !== options.recipient || stopped || !streams.has(id))
				throw new Error();
			const ws = new ClientSocket(address(options.endpoint, `pipe/${id}`), {
				headers: { authorization: `Bearer ${options.secret}` },
			});
			stream.ws = ws;
			ws.binaryType = "arraybuffer";
			let expiresAt = access.expiresAt,
				renewing = false;
			const streamId = id;
			function expire() {
				if (stream.timer) clearTimeout(stream.timer);
				stream.timer = setTimeout(
					() => closeStream(streamId),
					Math.max(0, expiresAt - Date.now()),
				);
			}
			expire();
			ws.onopen = () => {
				if (stopped || !streams.has(id)) {
					ws.close();
					return;
				}
				const channel = new Channel({
					send: (data) => {
						if (ws.readyState === WebSocket.OPEN) ws.send(data);
					},
					close: () => ws.close(),
					buffered: () => ws.bufferedAmount,
				});
				stream.channel = channel;
				const tcp = createConnection({
					host: "127.0.0.1",
					port: upstream.port,
					allowHalfOpen: true,
				});
				stream.tcp = tcp;
				tcp.on("error", () => closeStream(id));
				channel.on("error", () => closeStream(id));
				tcp.on("close", () => {
					// A clean TCP close can precede the channel draining its final writes.
					// Let pipe deliver FIN after those bytes; only abort on a truncated close.
					if (!tcp.readableEnded || !tcp.writableFinished) closeStream(id);
				});
				channel.on("close", () => closeStream(id));
				channel.pipe(tcp).pipe(channel);
			};
			ws.onmessage = (event) => {
				if (event.data instanceof ArrayBuffer) {
					stream.channel?.receive(new Uint8Array(event.data));
					return;
				}
				if (
					typeof event.data !== "string" ||
					event.data.length > 8192 ||
					renewing
				) {
					closeStream(id);
					return;
				}
				renewing = true;
				void verifyCapability(
					event.data,
					options.key,
					options.origin,
					options.session,
					target,
				)
					.then((access) => {
						if (
							access.recipient !== options.recipient ||
							!["ready", "reused"].includes(upstream.status)
						)
							throw new Error();
						expiresAt = Math.max(expiresAt, access.expiresAt);
						if (streams.has(id)) expire();
					})
					.catch(() => closeStream(id))
					.finally(() => {
						renewing = false;
					});
			};
			ws.onerror = () => closeStream(id);
			ws.onclose = () => closeStream(id);
		} catch {
			closeStream(id);
		}
	}
	control.onmessage = (event) => {
		if (typeof event.data !== "string" || event.data.length > 10000) {
			close();
			return;
		}
		if (event.data === "pong") {
			seen = Date.now();
			return;
		}
		try {
			const message = JSON.parse(event.data);
			if (message.type === "ready") {
				seen = Date.now();
				clearTimeout(startup);
				resolveReady();
			} else if (message.type === "open") void open(message);
			else close();
		} catch {
			close();
		}
	};
	control.onerror = close;
	control.onclose = close;
	options.signal.addEventListener("abort", close, { once: true });
	if (options.signal.aborted) close();
	return {
		ready,
		exited,
		close,
		disconnectTarget: (id) => {
			for (const [streamId, s] of streams)
				if (s.target === id) closeStream(streamId);
		},
	};
}
