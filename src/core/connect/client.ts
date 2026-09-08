import {
	type DirectorySnapshot,
	directoryOrigin,
	jsonBody,
	parseDirectory,
	type Snapshot,
} from "./protocol";
export class DirectoryError extends Error {
	constructor(readonly status: number) {
		super(`Connection directory returned ${status}`);
	}
}
export class DirectoryClient {
	readonly origin: string;
	constructor(
		origin: string,
		private request: typeof fetch = fetch,
	) {
		this.origin = directoryOrigin(origin);
	}
	async call(
		path: string,
		secret?: string,
		method = "GET",
		body?: unknown,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const response = await this.request(`${this.origin}${path}`, {
			method,
			headers: {
				...(secret ? { authorization: `Bearer ${secret}` } : {}),
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			redirect: "error",
			signal: AbortSignal.any([
				AbortSignal.timeout(8000),
				...(signal ? [signal] : []),
			]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new DirectoryError(response.status);
		}
		return jsonBody(response);
	}
	path(recipient: string, suffix = ""): string {
		return `/v1/devices/${encodeURIComponent(recipient)}${suffix}`;
	}
	async create(recipient: string, owner: string, token: string) {
		await this.call(this.path(recipient), undefined, "POST", {
			owner,
			token,
		});
	}
	async list(recipient: string, owner: string): Promise<DirectorySnapshot> {
		return parseDirectory(
			await this.call(this.path(recipient, "/sessions"), owner),
			recipient,
			Date.now(),
			this.origin,
		);
	}
	async publish(
		recipient: string,
		credential: string,
		sessionSecret: string,
		snapshot: Snapshot,
		signal?: AbortSignal,
	) {
		return this.call(
			this.path(recipient, `/sessions/${snapshot.sessionId}`),
			credential,
			"PUT",
			{ sessionSecret, snapshot },
			signal,
		);
	}
	async withdraw(recipient: string, session: string, credential: string) {
		await this.call(
			this.path(recipient, `/sessions/${session}`),
			credential,
			"DELETE",
		);
	}
}
