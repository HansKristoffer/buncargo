/**
 * Idempotent Pub/Sub topic provisioning against the Firebase Pub/Sub emulator.
 */

import { anySignal } from "hanzio";

/** Per-request timeout when provisioning topics against the local Pub/Sub emulator. */
const TOPIC_REQUEST_TIMEOUT_MS = 15_000;
/** Max concurrent topic PUTs against the local Pub/Sub emulator. */
const TOPIC_CONCURRENCY = 8;

export interface EnsurePubsubTopicsInput {
	readonly host: string;
	readonly port: number;
	readonly projectId: string;
	readonly topics: readonly string[];
	readonly signal?: AbortSignal;
	readonly fetchImpl?: typeof fetch;
}

function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Create every topic in `topics` on the Pub/Sub emulator via its REST API.
 * HTTP 200, 201 and 409 (`ALREADY_EXISTS`) all succeed idempotently.
 */
export async function ensurePubsubTopics(
	input: EnsurePubsubTopicsInput,
): Promise<void> {
	const unique = [
		...new Set(input.topics.map((t) => t.trim()).filter(Boolean)),
	];
	if (unique.length === 0) return;

	const doFetch = input.fetchImpl ?? fetch;
	const urlHost = formatHostForUrl(input.host);
	const baseUrl = `http://${urlHost}:${input.port}/v1/projects/${encodeURIComponent(input.projectId)}/topics`;

	const provisionOne = async (topic: string): Promise<void> => {
		input.signal?.throwIfAborted();
		const url = `${baseUrl}/${encodeURIComponent(topic)}`;
		const requestSignal = anySignal(
			input.signal,
			AbortSignal.timeout(TOPIC_REQUEST_TIMEOUT_MS),
		);
		let response: Response;
		try {
			response = await doFetch(url, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: "{}",
				signal: requestSignal,
			});
		} catch (error) {
			input.signal?.throwIfAborted();
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not create Pub/Sub topic "${topic}" on emulator ${urlHost}:${input.port}: ${detail}`,
			);
		}

		if (
			response.status !== 200 &&
			response.status !== 201 &&
			response.status !== 409
		) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`Pub/Sub emulator rejected topic "${topic}" with HTTP ${response.status}${body ? `: ${body.trim()}` : ""}`,
			);
		}
	};

	const workers = Math.min(TOPIC_CONCURRENCY, unique.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < unique.length) {
				const topic = unique[next++];
				if (topic !== undefined) await provisionOne(topic);
			}
		}),
	);
}
