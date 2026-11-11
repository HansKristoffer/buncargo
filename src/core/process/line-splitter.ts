/**
 * Bytes to lines, the one way: a streaming decoder, so a character cut at a
 * chunk's end waits for the rest instead of becoming U+FFFD, and a cap, so an
 * app that prints without newlines does not grow the buffer without bound.
 */

/** Past this many characters without a newline, the text so far is a line of its own. */
export const MAX_LINE_CHARS = 64 * 1024;

export interface LineSplitter {
	push(chunk: Uint8Array | string): void;
	/** The stream ended: what is left is the last line. */
	end(): void;
}

export function createLineSplitter(handlers: {
	onLine(line: string): void;
	/** The decoded text of each chunk, before its lines. */
	onText?(text: string): void;
}): LineSplitter {
	const decoder = new TextDecoder();
	let buffer = "";
	const drain = () => {
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			handlers.onLine(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
		while (buffer.length > MAX_LINE_CHARS) {
			handlers.onLine(buffer.slice(0, MAX_LINE_CHARS));
			buffer = buffer.slice(MAX_LINE_CHARS);
		}
	};
	return {
		push(chunk) {
			const text =
				typeof chunk === "string"
					? chunk
					: decoder.decode(chunk, { stream: true });
			if (!text) return;
			handlers.onText?.(text);
			buffer += text;
			drain();
		},
		end() {
			buffer += decoder.decode();
			drain();
			if (buffer) handlers.onLine(buffer);
			buffer = "";
		},
	};
}

/** Each line of a piped stream, decoded across chunk boundaries. */
export function forEachLine(
	stream: NodeJS.ReadableStream | null,
	handlers: Parameters<typeof createLineSplitter>[0],
): void {
	if (!stream) return;
	const splitter = createLineSplitter(handlers);
	stream.on("data", (chunk: Uint8Array | string) => splitter.push(chunk));
	stream.on("end", () => splitter.end());
}
