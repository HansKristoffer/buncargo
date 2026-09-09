import { randomBytes } from "node:crypto";
import { withFileLock } from "../file-lock";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { connectOrigin } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { type Receiver, readJSON, record } from "./protocol";
export const newCredential = (kind: string) =>
	`bc_${kind}_${randomBytes(32).toString("hex")}`;
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
export function readReceiver() {
	return readJsonDocument(receiverPath(), (value) => {
		const r = record(value);
		return typeof r.id === "string" &&
			/^bc_owner_[a-f0-9]{64}$/.test(String(r.owner)) &&
			/^bc_share_[a-f0-9]{64}$/.test(String(r.token)) &&
			r.origin === connectOrigin()
			? (r as unknown as Receiver)
			: undefined;
	});
}
export async function ensureReceiver(rotate = false): Promise<Receiver> {
	return withFileLock(receiverPath(), async () => {
		let r = await readReceiver();
		if (!r)
			r = await request<Receiver>(
				connectOrigin(),
				"/v1/receivers",
				undefined,
				{},
			);
		else if (rotate)
			r.token = (
				await request<{ token: string }>(
					r.origin,
					"/v1/receiver/token",
					r.owner,
					{},
				)
			).token;
		if (
			r.origin !== connectOrigin() ||
			!/^bc_owner_[a-f0-9]{64}$/.test(r.owner) ||
			!/^bc_share_[a-f0-9]{64}$/.test(r.token)
		)
			throw new Error("Invalid receiver registration");
		await writeJsonDocument(receiverPath(), r);
		return r;
	});
}
