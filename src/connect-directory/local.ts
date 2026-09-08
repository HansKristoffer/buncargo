/** Local operator/test server. Uses the same relay and authorization as the Worker. */
import { exportJWK, generateKeyPair } from "jose";
import { identifier } from "../core/connect/protocol";
import {
	RecipientRelay,
	type RelayAdmission,
	type RelayListener,
} from "./relay";
import { type DeviceState, directoryRequest } from "./service";
export async function startLocalDirectory(port = 0) {
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const key = await exportJWK(keys.privateKey),
		publicKey = await exportJWK(keys.publicKey);
	const records = new Map<string, DeviceState>(),
		relays = new Map<string, RecipientRelay>();
	let pending: Promise<unknown> = Promise.resolve();
	const server = Bun.serve<{
		relay: RecipientRelay;
		admission: RelayAdmission;
		listener?: RelayListener;
	}>({
		hostname: "127.0.0.1",
		port,
		idleTimeout: 0,
		maxRequestBodySize: 128 * 1024,
		async fetch(request, server) {
			if (new URL(request.url).pathname === "/v1/key")
				return Response.json(publicKey);
			const recipientId = new URL(request.url).pathname.split("/")[3];
			if (!identifier(recipientId))
				return new Response("Not found", { status: 404 });
			let relay = relays.get(recipientId);
			if (!relay) {
				relay = new RecipientRelay({
					recipient: recipientId,
					key,
					origin: server.url.origin,
					load: async () => records.get(recipientId),
				});
				relays.set(recipientId, relay);
			}
			const selected = relay;
			const operation = pending
				.catch(() => {})
				.then(async () => {
					if (new URL(request.url).pathname.includes("/relay/")) {
						try {
							const admission = await selected.admit(request);
							if (
								server.upgrade(request, {
									data: { relay: selected, admission },
								})
							)
								return;
						} catch {}
						return new Response("Relay unavailable or unauthorized", {
							status: 403,
						});
					}
					const response = await directoryRequest(request, {
						recipientId,
						key,
						origin: server.url.origin,
						relayReady: (s) => selected.ready(s),
						storage: {
							load: async () => records.get(recipientId),
							save: async (state) => {
								records.set(recipientId, state);
							},
						},
					});
					selected.reconcile(records.get(recipientId));
					return response;
				});
			pending = operation;
			return operation;
		},
		websocket: {
			maxPayloadLength: 65537,
			idleTimeout: 0,
			backpressureLimit: 4 * 1024 * 1024,
			closeOnBackpressureLimit: true,
			open(ws) {
				ws.data.listener = ws.data.relay.open(ws.data.admission, ws);
			},
			message(ws, data) {
				ws.data.listener?.message(data);
			},
			close(ws) {
				ws.data.listener?.close();
			},
		},
	});
	return {
		url: server.url.origin,
		publicKey,
		signingKey: key,
		stop: async () => {
			for (const r of relays.values()) r.stop();
			await server.stop(true);
		},
	};
}
if (import.meta.main) {
	const server = await startLocalDirectory(Number(process.argv[2] ?? 8787));
	console.log(
		`Local connection directory: ${server.url} (ephemeral test data)`,
	);
}
