import { createTailscaleClient, tailnetStatus } from "./client";
import { parseRemoteDirectory, type RemoteDirectory } from "./protocol";
import { DIRECTORY_PORT } from "./state";

/** Normalize a peer hostname or full URL into the directory HTTPS endpoint. */
export function directoryEndpoint(value: string): URL {
	const url = new URL(
		value.includes("://") ? value : `https://${value}:${DIRECTORY_PORT}`,
	);

	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)
	) {
		throw new Error("Use a full Tailscale MagicDNS HTTPS hostname");
	}

	url.pathname = "/v1/runs";
	url.search = "";
	url.hash = "";

	return url;
}

/**
 * Probe online tailnet peers for a buncargo directory response.
 *
 * Uses a small worker pool so discovery stays bounded on large tailnets.
 */
export async function discoverTailnetPeers() {
	const { self, peers } = await tailnetStatus(createTailscaleClient());
	const found: { hostname: string; directory: RemoteDirectory }[] = [];
	let next = 0;

	await Promise.all(
		Array.from({ length: Math.min(4, peers.length) }, async () => {
			for (;;) {
				const peer = peers[next++];
				if (!peer) return;

				if (!peer.online || peer.id === self.id) continue;

				try {
					const response = await fetch(directoryEndpoint(peer.hostname), {
						signal: AbortSignal.timeout(2000),
						redirect: "error",
					});

					if (!response.ok) continue;

					const raw = await readLimitedBody(response, 1024 * 1024);
					const directory = parseRemoteDirectory(
						JSON.parse(raw),
						peer.hostname,
						peer.id,
					);
					found.push({ hostname: peer.hostname, directory });
				} catch {
					/* Most peers do not run buncargo. */
				}
			}
		}),
	);

	return found.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/** Read a response body with a hard byte cap to reject oversized directories. */
export async function readLimitedBody(
	response: Response,
	limit: number,
): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty directory response");

	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;

			size += result.value.byteLength;

			if (size > limit) {
				throw new Error("Directory response too large");
			}

			chunks.push(result.value);
		}
	} finally {
		await reader.cancel();
	}

	return Buffer.concat(chunks).toString("utf8");
}
