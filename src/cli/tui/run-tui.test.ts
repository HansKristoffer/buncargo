import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * A crash must never leave the user's terminal broken: raw mode off, the
 * alternate screen left, the cursor shown, whichever way the process ends.
 * The child runs under a real pseudo-terminal, and `stty` reads the same
 * terminal once it is gone.
 */
async function runChild(how: "throw" | "exit" | "sigterm") {
	const child = join(import.meta.dir, "tui-child.testing.ts");
	let output = "";
	const proc = Bun.spawn(
		[
			"sh",
			"-c",
			`${JSON.stringify(process.execPath)} ${JSON.stringify(child)} ${how}; stty -a`,
		],
		{
			terminal: {
				cols: 80,
				rows: 20,
				data: (_terminal, data) => {
					output += new TextDecoder().decode(data);
				},
			},
		},
	);
	if (how === "sigterm") {
		await Bun.sleep(400);
		Bun.spawnSync(["pkill", "-TERM", "-f", "tui-child.testing.ts sigterm"]);
	}
	await proc.exited;
	return output;
}

describe("RunTui terminal restore", () => {
	for (const how of ["throw", "exit", "sigterm"] as const) {
		it(`restores the terminal when the process ends by ${how}`, async () => {
			const output = await runChild(how);
			expect(output).toContain("\u001b[?1049h");
			const after = output.slice(output.lastIndexOf("\u001b[?1049h"));
			expect(after).toContain("\u001b[?1049l");
			expect(after.lastIndexOf("\u001b[?25h")).toBeGreaterThan(
				after.lastIndexOf("\u001b[?25l"),
			);
			// Canonical mode and echo are back on: not raw any more.
			expect(output).toMatch(/[^-]icanon/);
			expect(output).toMatch(/[^-]echo\b/);
		});
	}
});
