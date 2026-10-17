import type { ChildProcess } from "node:child_process";
import { formatPrefixedLine, isBlankLogLine } from "../style";

function forEachLine(
	stream: NodeJS.ReadableStream | null,
	onLine: (line: string) => void,
): void {
	if (!stream) {
		return;
	}

	let buffer = "";
	const emit = (line: string) => {
		if (!isBlankLogLine(line)) onLine(line);
	};
	stream.on("data", (chunk: Buffer | string) => {
		buffer += String(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			emit(line);
		}
	});
	stream.on("end", () => {
		if (buffer) {
			emit(buffer);
		}
	});
}

/** Each non-blank line of a piped child's stdout and stderr. */
export function forEachOutputLine(
	child: ChildProcess,
	onLine: (line: string) => void,
): void {
	forEachLine(child.stdout, onLine);
	forEachLine(child.stderr, onLine);
}

/** Both output streams of a piped child, prefixed with its name. */
export function prefixOutput(
	name: string,
	child: ChildProcess,
	options: { width: number },
): void {
	forEachOutputLine(child, (line) =>
		process.stdout.write(formatPrefixedLine(name, line, options.width)),
	);
}
