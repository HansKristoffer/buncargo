import { withFileLock } from "../file-lock";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { connectOrigin } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { isForgotten, readJSON } from "./json";
import {
	type Directory,
	parseDirectory,
	type Receiver,
	record,
} from "./protocol";

/** Keep authorization in headers and reject redirects that could forward it elsewhere. */
export async function request<T>(
	origin: string,
	path: string,
	credential?: string,
	body?: unknown,
	method = body === undefined ? "GET" : "POST",
): Promise<T> {
	const response = await fetch(`${origin}${path}`, {
		method,
		redirect: "error",
		signal: AbortSignal.timeout(10000),
		headers: {
			...(credential ? { authorization: `Bearer ${credential}` } : {}),
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	return (await readJSON(response)) as T;
}

export const receiverPath = () => stateFilePath("connect-receiver.json");

/** A receiver of this relay with well-formed credentials, from its checked fields. */
function parseReceiver(value: unknown): Receiver | undefined {
	const { id, origin, owner, token } = record(value);
	if (
		typeof id !== "string" ||
		origin !== connectOrigin() ||
		typeof owner !== "string" ||
		!/^bc_owner_[a-f0-9]{64}$/.test(owner) ||
		typeof token !== "string" ||
		!/^bc_share_[a-f0-9]{64}$/.test(token)
	)
		return undefined;
	return { id, origin, owner, token };
}

function readReceiver() {
	return readJsonDocument(receiverPath(), parseReceiver);
}

export async function requireReceiver(): Promise<Receiver> {
	const receiver = await readReceiver();
	if (!receiver) {
		throw new Error("Run buncargo connect token first");
	}
	return receiver;
}

const registerReceiver = () =>
	request<Receiver>(connectOrigin(), "/v1/receivers", undefined, {});

/**
 * Serialize registration/rotation so concurrent bar and CLI actions keep one
 * owner identity. Rotating a receiver the relay forgot registers a new one:
 * either way, senders need the new token.
 */
export async function ensureReceiver(rotate = false): Promise<Receiver> {
	return withFileLock(receiverPath(), async () => {
		let receiver = await readReceiver();
		if (!receiver) {
			receiver = await registerReceiver();
		} else if (rotate) {
			const current = receiver;
			receiver = await request<{ token: string }>(
				current.origin,
				"/v1/receiver/token",
				current.owner,
				{},
			).then(
				({ token }) => ({ ...current, token }),
				(error) => {
					if (!isForgotten(error)) throw error;
					return registerReceiver();
				},
			);
		}

		const registered = parseReceiver(receiver);
		if (!registered) {
			throw new Error("Invalid receiver registration");
		}
		await writeJsonDocument(receiverPath(), registered);
		return registered;
	});
}

export function emptyDirectory(notice?: string): Directory {
	return {
		version: 1,
		configured: false,
		origin: connectOrigin(),
		generatedAt: Date.now(),
		runs: [],
		...(notice === undefined ? {} : { notice }),
	};
}

export async function readDirectory(): Promise<Directory> {
	const receiver = await readReceiver();
	if (!receiver) {
		return emptyDirectory(
			"Copy a connection token to receive shared environments.",
		);
	}

	const value = await request(
		receiver.origin,
		"/v1/receiver/runs",
		receiver.owner,
	).catch((error) => {
		if (!isForgotten(error)) throw error;
		const message = `${receiver.origin} no longer knows this machine's receiver. Run buncargo connect token --rotate and give the new token to whoever shares with you.`;
		throw new Error(message);
	});
	return parseDirectory(value, receiver.origin);
}
