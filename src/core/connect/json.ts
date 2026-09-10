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

export async function readJSON(response: Response): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Connection directory request failed (${response.status})`);
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
