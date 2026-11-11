/** Enforce the limit while streaming, including bodies without Content-Length. */
export async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	overflow: Error,
): Promise<Buffer> {
	if (!body) {
		return Buffer.alloc(0);
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			size += value.length;
			if (size > maxBytes) {
				throw overflow;
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	} finally {
		await reader.cancel();
	}
}

/** The directory and the coordinator both explain a refusal in an `error` field. */
async function readError(response: Response): Promise<string> {
	const fallback = `Connection directory request failed (${response.status})`;
	try {
		const body = await readBoundedBody(response.body, 16384, new Error());
		const { error } = JSON.parse(body.toString()) as { error?: unknown };
		return typeof error === "string" && error ? error : fallback;
	} catch {
		return fallback;
	}
}

/** A refusal the directory or the coordinator answered, with its HTTP status. */
class ConnectRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ConnectRequestError";
	}
}

/**
 * The directory answered that it does not know the credential: it forgot it.
 * Its own refusal, not a 403 from something in front of it.
 */
export function isForgotten(error: unknown): boolean {
	return (
		error instanceof ConnectRequestError &&
		error.status === 403 &&
		error.message === "Not authorized"
	);
}

export async function readJSON(response: Response): Promise<unknown> {
	if (!response.ok) {
		throw new ConnectRequestError(await readError(response), response.status);
	}
	if (!response.body) {
		throw new Error("Empty directory response");
	}

	const body = await readBoundedBody(
		response.body,
		1024 * 1024,
		new Error("Directory response too large"),
	);
	return JSON.parse(body.toString());
}
