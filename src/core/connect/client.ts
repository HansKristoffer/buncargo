import { withFileLock } from "../file-lock";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { connectOrigin } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { readJSON } from "./json";
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

function hasReceiverCredentials(value: Record<string, unknown>): boolean {
	return (
		value.origin === connectOrigin() &&
		/^bc_owner_[a-f0-9]{64}$/.test(String(value.owner)) &&
		/^bc_share_[a-f0-9]{64}$/.test(String(value.token))
	);
}

export function readReceiver() {
	return readJsonDocument(receiverPath(), (value) => {
		const receiver = record(value);
		return typeof receiver.id === "string" && hasReceiverCredentials(receiver)
			? (receiver as unknown as Receiver)
			: undefined;
	});
}

export async function requireReceiver(): Promise<Receiver> {
	const receiver = await readReceiver();
	if (!receiver) {
		throw new Error("Run buncargo connect token first");
	}
	return receiver;
}

/** Serialize registration/rotation so concurrent bar and CLI actions keep one owner identity. */
export async function ensureReceiver(rotate = false): Promise<Receiver> {
	return withFileLock(receiverPath(), async () => {
		let receiver = await readReceiver();
		if (!receiver) {
			receiver = await request<Receiver>(
				connectOrigin(),
				"/v1/receivers",
				undefined,
				{},
			);
		} else if (rotate) {
			const result = await request<{ token: string }>(
				receiver.origin,
				"/v1/receiver/token",
				receiver.owner,
				{},
			);
			receiver.token = result.token;
		}

		if (!hasReceiverCredentials(record(receiver))) {
			throw new Error("Invalid receiver registration");
		}
		await writeJsonDocument(receiverPath(), receiver);
		return receiver;
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
	);
	return parseDirectory(value, receiver.origin);
}
