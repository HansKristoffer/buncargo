import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * readline holds the terminal in raw mode while it asks, so Ctrl-C arrives as
 * a byte rather than a signal, and Ctrl-D closes the interface without an
 * answer. Either one used to leave the question pending forever. The child
 * runs under a real pseudo-terminal so the keys go through the same path.
 */
async function answerWith(keys: string, mode: "bare" | "listener") {
	const child = join(import.meta.dir, "prompt-child.testing.ts");
	let output = "";
	let asked = false;
	const proc = Bun.spawn([process.execPath, child, mode], {
		terminal: {
			cols: 80,
			rows: 20,
			data: (terminal, data) => {
				output += new TextDecoder().decode(data);
				if (!asked && output.includes("  > ")) {
					asked = true;
					terminal.write(keys);
				}
			},
		},
	});
	const deadline = setTimeout(() => proc.kill("SIGKILL"), 4000);
	await proc.exited;
	clearTimeout(deadline);
	return {
		exitCode: proc.exitCode,
		signalCode: proc.signalCode,
		output: Bun.stripANSI(output),
	};
}

describe("askChoice at a terminal", () => {
	for (const [name, key] of [
		["Ctrl-C", "\x03"],
		["Ctrl-D", "\x04"],
	] as const) {
		it(`${name} ends a command with no SIGINT listener by SIGINT`, async () => {
			const result = await answerWith(key, "bare");
			expect(result.signalCode).toBe("SIGINT");
		});

		it(`${name} rejects the question for a command that handles SIGINT`, async () => {
			const result = await answerWith(key, "listener");
			expect(result.output).toContain("interrupted");
			expect(result.exitCode).toBe(130);
		});
	}

	it("still returns a typed answer", async () => {
		const result = await answerWith("y\r", "bare");
		expect(result.output).toContain("answer: true");
		expect(result.exitCode).toBe(0);
	});
});
