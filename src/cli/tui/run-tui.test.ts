import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { RunOutput } from "../../core/process/run-output";
import { RunTui } from "./run-tui";

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

/** A terminal that records what was written and whether raw mode is on. */
function fakeTerminal() {
	const writes: string[] = [];
	const stdin = Object.assign(new PassThrough(), {
		raw: false,
		setRawMode(on: boolean) {
			stdin.raw = on;
			return stdin;
		},
	});
	const stdout = Object.assign(new PassThrough(), {
		columns: 80,
		rows: 20,
		write(chunk: string | Uint8Array) {
			writes.push(String(chunk));
			return true;
		},
	});
	return {
		stdin: stdin as unknown as NodeJS.ReadStream & { raw: boolean },
		stdout: stdout as unknown as NodeJS.WriteStream,
		writes,
	};
}

describe("RunTui", () => {
	it("completes write callbacks of output it captures", async () => {
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		tui.start();
		try {
			await new Promise<void>((resolve) =>
				process.stdout.write("from a hook\n", () => resolve()),
			);
			await new Promise<void>((resolve) =>
				process.stderr.write("warned\n", "utf8", () => resolve()),
			);
		} finally {
			tui.stop();
		}
		expect(output.tail("buncargo")).toEqual(["from a hook", "warned"]);
	});

	it("leaves the terminal restored when the run ends while the pager is open", async () => {
		const terminal = fakeTerminal();
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tui-pager-"));
		const saved = process.env.PAGER;
		const pager = join(dir, "pager.sh");
		writeFileSync(pager, "#!/bin/sh\nsleep 5\n");
		chmodSync(pager, 0o755);
		process.env.PAGER = pager;
		const tui = new RunTui({
			output: new RunOutput(),
			apps: ["api"],
			urlFor: () => undefined,
			logPath: () => join(dir, "api.log"),
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		try {
			tui.start();
			terminal.stdin.write("j");
			terminal.stdin.write("l");
			await Bun.sleep(200);
			// Suspended: the pager has the keys and the plain screen.
			expect(terminal.stdin.raw).toBe(false);
			expect(terminal.stdin.listenerCount("data")).toBe(0);
			tui.stop();
			await Bun.sleep(300);
			const last = terminal.writes.join("");
			expect(last.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(
				last.lastIndexOf("\u001b[?1049h"),
			);
			expect(terminal.stdin.raw).toBe(false);
		} finally {
			tui.stop();
			if (saved === undefined) delete process.env.PAGER;
			else process.env.PAGER = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
