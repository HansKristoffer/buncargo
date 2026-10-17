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

export async function readJSON(response: Response): Promise<unknown> {
	if (!response.ok) {
		throw new Error(await readError(response));
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
