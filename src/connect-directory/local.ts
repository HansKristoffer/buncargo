/** Ephemeral directory for integration tests, using production authorization. */
import { identifier } from "../core/connect/protocol";
import { type DeviceState, directoryRequest } from "./service";
export async function startLocalDirectory(port = 0) {
	const records = new Map<string, DeviceState>();
	let pending: Promise<unknown> = Promise.resolve();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		maxRequestBodySize: 128 * 1024,
		fetch(request, server) {
			const recipientId = new URL(request.url).pathname.split("/")[3];
			if (!identifier(recipientId))
				return new Response("Not found", { status: 404 });
			const operation = pending
				.catch(() => {})
				.then(() =>
					directoryRequest(request, {
						recipientId,
						origin: server.url.origin,
						storage: {
							load: async () => records.get(recipientId),
							save: async (state) => {
								records.set(recipientId, state);
							},
						},
					}),
				);
			pending = operation;
			return operation;
		},
	});
	return { url: server.url.origin, stop: () => server.stop(true) };
}
if (import.meta.main) {
	const server = await startLocalDirectory(Number(process.argv[2] ?? 8787));
	console.log(
		`Local connection directory: ${server.url} (ephemeral test data)`,
	);
}
