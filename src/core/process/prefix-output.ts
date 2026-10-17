import type { ChildProcess } from "node:child_process";
import { formatPrefixedLine, isBlankLogLine } from "../style";

function prefixStream(
	name: string,
	stream: NodeJS.ReadableStream | null,
	options: { width: number },
): void {
	if (!stream) {
		return;
	}

	let buffer = "";
	const writeLine = (line: string) => {
		if (isBlankLogLine(line)) {
			return;
		}
		process.stdout.write(formatPrefixedLine(name, line, options.width));
	};
	stream.on("data", (chunk: Buffer | string) => {
		buffer += String(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			writeLine(line);
		}
	});
	stream.on("end", () => {
		if (buffer) {
			writeLine(buffer);
		}
	});
}

/** Both output streams of a piped child, prefixed with its name. */
export function prefixOutput(
	name: string,
	child: ChildProcess,
	options: Parameters<typeof prefixStream>[2],
): void {
	prefixStream(name, child.stdout, options);
	prefixStream(name, child.stderr, options);
}
