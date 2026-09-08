import type { JWK } from "jose";
import { verifyCapability } from "../core/connect/capability";
import { hashSecret, identifier } from "../core/connect/protocol";
import type { DeviceState } from "./service";

export interface RelaySocket {
	send(data: string | Uint8Array | ArrayBuffer): unknown;
	close(code?: number, reason?: string): void;
}
export interface RelayListener {
	message(data: string | ArrayBuffer | Uint8Array): void;
	close(): void;
}
export type RelayAdmission = { session: string; hash: string } & (
	| { role: "publisher" }
	| {
			role: "client";
			id: string;
			target: string;
			capability: string;
			expiresAt: number;
	  }
	| { role: "pipe"; id: string }
);
interface Control {
	socket: RelaySocket;
	hash: string;
	seen: number;
}
interface Stream {
	id: string;
	session: string;
	target: string;
	hash: string;
	client: RelaySocket;
	publisher?: RelaySocket;
	capability: string;
	expiresAt: number;
	created: number;
	inflight: [number, number];
	renewing: boolean;
	controls: number;
	windowAt: number;
}
export const RELAY_STREAM_LIMIT = 64;
const WINDOW = 128 * 1024 + 65537;
const fail = () => {
	throw new Error("Relay unavailable or unauthorized");
};

/** A recipient owns its control connections and streams. No URLs or ports are supplied by clients. */
export class RecipientRelay {
	private controls = new Map<string, Control>();
	private streams = new Map<string, Stream>();
	private timer?: ReturnType<typeof setInterval>;
	constructor(
		private options: {
			recipient: string;
			origin: string;
			key: JWK;
			load(): Promise<DeviceState | undefined>;
			now?: () => number;
		},
	) {}
	private now() {
		return this.options.now?.() ?? Date.now();
	}
	ready(session: string): boolean {
		const c = this.controls.get(session);
		return !!c && c.seen > this.now() - 45000;
	}
	private live(state: DeviceState | undefined, session: string) {
		const entry = state?.sessions[session];
		return entry && !entry.withdrawn && entry.snapshot.expiresAt > this.now()
			? entry
			: undefined;
	}
	async admit(request: Request): Promise<RelayAdmission> {
		if (
			request.method !== "GET" ||
			request.headers.has("origin") ||
			request.headers.get("upgrade")?.toLowerCase() !== "websocket"
		)
			return fail();
		const path = new URL(request.url).pathname.split("/");
		const session = path[5],
			role = path[7],
			id = path[8];
		if (
			!identifier(session) ||
			path[6] !== "relay" ||
			!["publisher", "stream", "pipe"].includes(role)
		)
			return fail();
		if (
			(role === "publisher" && path.length !== 8) ||
			(role !== "publisher" && (!identifier(id) || path.length !== 9))
		)
			return fail();
		const bearer =
			request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		if (!bearer || bearer.length > 8192) return fail();
		const entry = this.live(await this.options.load(), session);
		if (!entry) return fail();
		if (role === "stream") {
			if (!this.ready(session) || this.streams.size >= RELAY_STREAM_LIMIT)
				return fail();
			const target = entry.snapshot.targets.find((t) => t.id === id);
			if (!target || !["ready", "reused"].includes(target.status))
				return fail();
			const access = await verifyCapability(
				bearer,
				this.options.key,
				this.options.origin,
				session,
				id,
			);
			if (access.recipient !== this.options.recipient) return fail();
			return {
				role: "client",
				session,
				target: id,
				id: crypto.randomUUID(),
				capability: bearer,
				expiresAt: access.expiresAt,
				hash: entry.hash,
			};
		}
		if ((await hashSecret(bearer)) !== entry.hash) return fail();
		if (role === "pipe") {
			const stream = this.streams.get(id);
			if (
				!stream ||
				stream.session !== session ||
				stream.publisher ||
				stream.hash !== entry.hash
			)
				return fail();
		}
		return role === "pipe"
			? { role: "pipe", session, id, hash: entry.hash }
			: { role: "publisher", session, hash: entry.hash };
	}
	open(admission: RelayAdmission, socket: RelaySocket): RelayListener {
		this.startTimer();
		const { session } = admission;
		if (admission.role === "publisher") {
			const previous = this.controls.get(session);
			if (previous) {
				this.controls.delete(session);
				previous.socket.close(1012, "Publisher reconnected");
				this.closeSession(session);
			}
			const control = { socket, hash: admission.hash, seen: this.now() };
			this.controls.set(session, control);
			socket.send(JSON.stringify({ type: "ready" }));
			let checking = false;
			return {
				message: (data) => {
					if (
						typeof data !== "string" ||
						data !== "ping" ||
						checking ||
						this.now() - control.seen < 1000
					) {
						socket.close(1008, "Invalid heartbeat");
						return;
					}
					checking = true;
					void this.options
						.load()
						.then((state) => {
							if (
								!this.live(state, session) ||
								this.controls.get(session) !== control
							) {
								socket.close(1008, "Sharing ended");
								return;
							}
							control.seen = this.now();
							socket.send("pong");
						})
						.catch(() => socket.close(1011, "Directory unavailable"))
						.finally(() => {
							checking = false;
						});
				},
				close: () => {
					if (this.controls.get(session) === control) {
						this.controls.delete(session);
						this.closeSession(session);
					}
					this.stopTimerIfIdle();
				},
			};
		}
		if (admission.role === "client") {
			const control = this.controls.get(session);
			if (
				!control ||
				control.hash !== admission.hash ||
				this.streams.size >= RELAY_STREAM_LIMIT
			) {
				socket.close(1013, "Publisher unavailable");
				return { message() {}, close() {} };
			}
			const stream: Stream = {
				id: admission.id,
				session,
				target: admission.target,
				hash: admission.hash,
				client: socket,
				capability: admission.capability,
				expiresAt: admission.expiresAt,
				created: this.now(),
				inflight: [0, 0],
				renewing: false,
				controls: 0,
				windowAt: this.now(),
			};
			this.streams.set(stream.id, stream);
			control.socket.send(
				JSON.stringify({
					type: "open",
					id: stream.id,
					target: stream.target,
					capability: stream.capability,
				}),
			);
			return {
				message: (data) => this.message(stream, 0, data),
				close: () => this.closeStream(stream),
			};
		}
		const stream = this.streams.get(admission.id);
		if (!stream || stream.publisher || !this.ready(session)) {
			socket.close(1008, "Stream expired");
			return { message() {}, close() {} };
		}
		stream.publisher = socket;
		stream.client.send(JSON.stringify({ type: "ready" }));
		return {
			message: (data) => this.message(stream, 1, data),
			close: () => this.closeStream(stream),
		};
	}
	private message(
		stream: Stream,
		side: 0 | 1,
		data: string | ArrayBuffer | Uint8Array,
	) {
		if (!this.streams.has(stream.id)) return;
		if (this.now() >= stream.expiresAt) {
			this.closeStream(stream);
			return;
		}
		const peer = side === 0 ? stream.publisher : stream.client;
		if (!peer) {
			this.closeStream(stream);
			return;
		}
		if (typeof data === "string") {
			if (side !== 0 || data.length > 8192 || stream.renewing) {
				this.closeStream(stream);
				return;
			}
			stream.renewing = true;
			void Promise.all([
				verifyCapability(
					data,
					this.options.key,
					this.options.origin,
					stream.session,
					stream.target,
				),
				this.options.load(),
			])
				.then(([access, state]) => {
					const entry = this.live(state, stream.session);
					if (
						access.recipient !== this.options.recipient ||
						!entry ||
						entry.hash !== stream.hash ||
						!entry.snapshot.targets.some(
							(t) =>
								t.id === stream.target &&
								["ready", "reused"].includes(t.status),
						)
					)
						throw new Error();
					if (!this.streams.has(stream.id)) return;
					stream.expiresAt = Math.max(stream.expiresAt, access.expiresAt);
					peer.send(data);
				})
				.catch(() => this.closeStream(stream))
				.finally(() => {
					stream.renewing = false;
				});
			return;
		}
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		if (!bytes.length || bytes.length > 65537 || bytes[0] > 4) {
			this.closeStream(stream);
			return;
		}
		if (bytes[0] === 0) {
			stream.inflight[side] += bytes.length;
			if (stream.inflight[side] > WINDOW) {
				this.closeStream(stream);
				return;
			}
		} else if (bytes[0] === 4) {
			if (bytes.length !== 5) {
				this.closeStream(stream);
				return;
			}
			const ack = new DataView(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			).getUint32(1);
			const other = side === 0 ? 1 : 0;
			if (ack === 0 || ack > stream.inflight[other]) {
				this.closeStream(stream);
				return;
			}
			stream.inflight[other] -= ack;
		} else {
			if (bytes.length !== 1) {
				this.closeStream(stream);
				return;
			}
			if (this.now() - stream.windowAt >= 1000) {
				stream.windowAt = this.now();
				stream.controls = 0;
			}
			if (++stream.controls > 4096) {
				this.closeStream(stream);
				return;
			}
		}
		try {
			peer.send(bytes);
		} catch {
			this.closeStream(stream);
		}
	}
	reconcile(state: DeviceState | undefined) {
		for (const [session, control] of this.controls)
			if (!this.live(state, session)) {
				this.controls.delete(session);
				control.socket.close(1008, "Sharing ended");
				this.closeSession(session);
			}
		for (const stream of this.streams.values()) {
			const entry = this.live(state, stream.session);
			if (
				!entry?.snapshot.targets.some(
					(t) =>
						t.id === stream.target && ["ready", "reused"].includes(t.status),
				)
			)
				this.closeStream(stream);
		}
		this.stopTimerIfIdle();
	}
	private closeSession(session: string) {
		for (const s of this.streams.values())
			if (s.session === session) this.closeStream(s);
	}
	private closeStream(stream: Stream) {
		if (!this.streams.delete(stream.id)) return;
		stream.client.close(1000, "Stream closed");
		stream.publisher?.close(1000, "Stream closed");
		this.stopTimerIfIdle();
	}
	private startTimer() {
		this.timer ??= setInterval(() => {
			for (const [id, c] of this.controls)
				if (c.seen < this.now() - 45000) {
					this.controls.delete(id);
					c.socket.close(1008, "Heartbeat expired");
					this.closeSession(id);
				}
			for (const s of this.streams.values())
				if (
					s.expiresAt <= this.now() ||
					(!s.publisher && s.created < this.now() - 10000)
				)
					this.closeStream(s);
			this.stopTimerIfIdle();
		}, 1000);
	}
	private stopTimerIfIdle() {
		if (!this.controls.size && !this.streams.size && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
	stop() {
		for (const c of this.controls.values())
			c.socket.close(1001, "Relay stopped");
		this.controls.clear();
		for (const s of this.streams.values()) this.closeStream(s);
		this.stopTimerIfIdle();
	}
}
