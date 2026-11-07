import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { RunOutput } from "../../core/process/run-output";
import { RunTui } from "./run-tui";

/** Poll a condition until it holds or the deadline passes. */
async function until(condition: () => boolean, timeoutMs = 5_000) {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		if (performance.now() > deadline)
			throw new Error(`Condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * A crash must never leave the user's terminal broken: raw mode off, the
 * alternate screen left, the cursor shown, whichever way the process ends.
 * The child runs under a real pseudo-terminal, and `stty` reads the same
 * terminal once it is gone.
 */
async function runChild(how: "throw" | "reject" | "exit" | "sigterm") {
	const child = join(import.meta.dir, "tui-child.testing.ts");
	let output = "";
	const proc = Bun.spawn(
		[
			"sh",
			"-c",
			`${JSON.stringify(process.execPath)} ${JSON.stringify(child)} ${how}; echo "exit:$?"; stty -a`,
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
		// Once it has drawn a frame; by its own pid, never by a pattern other
		// worktrees' runs of this test share.
		await until(() => output.includes("hello from api"));
		const pid = Number(/pid:(\d+)/.exec(output)?.[1]);
		process.kill(pid, "SIGTERM");
	}
	await proc.exited;
	return output;
}

describe("RunTui terminal restore", () => {
	for (const how of ["throw", "reject", "exit", "sigterm"] as const) {
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

	// The error is printed after the screen is left, not erased with it.
	for (const [how, message] of [
		["throw", "boom"],
		["reject", "rejected"],
	] as const) {
		it(`shows the error of a ${how} after leaving the screen`, async () => {
			const output = await runChild(how);
			const after = Bun.stripANSI(
				output.slice(output.lastIndexOf("\u001b[?1049l")),
			);
			expect(after).toContain(`error: ${message}`);
			expect(after).toContain("exit:1");
		});
	}
});

describe("RunTui pager", () => {
	// The pager has the terminal in cooked mode, so Ctrl-C is a real SIGINT to
	// the whole process group, the run included. Like less, the fake pager
	// ignores it: only the TUI closing it ends it.
	it("closes the pager on Ctrl-C and keeps the run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tui-pager-int-"));
		const pager = join(dir, "pager.sh");
		writeFileSync(
			pager,
			"#!/bin/sh\ntrap '' INT\necho pager-open\nexec sleep 30\n",
		);
		chmodSync(pager, 0o755);
		const child = join(import.meta.dir, "tui-child.testing.ts");
		let output = "";
		const proc = Bun.spawn([process.execPath, child, "pager", pager], {
			terminal: {
				cols: 80,
				rows: 20,
				data: (_terminal, data) => {
					output += new TextDecoder().decode(data);
				},
			},
		});
		try {
			await until(() => output.includes("hello from api"));
			proc.terminal?.write("j");
			proc.terminal?.write("l");
			await until(() => output.includes("pager-open"));
			proc.terminal?.write("\u0003");
			// The TUI takes the screen back once the pager is gone.
			const reentered = () =>
				output.slice(output.indexOf("pager-open")).includes("\u001b[?1049h");
			await until(() => reentered() || output.includes("run interrupted"));
			expect(output).not.toContain("run interrupted");
			expect(reentered()).toBe(true);
		} finally {
			// By its own pid, never by a pattern other worktrees' runs share.
			const pid = Number(/pid:(\d+)/.exec(output)?.[1]);
			if (pid) process.kill(pid, "SIGTERM");
			await proc.exited;
			rmSync(dir, { recursive: true, force: true });
		}
		expect(proc.exitCode).toBe(143);
	});
});

/** Keys and mouse reports as the TUI reads them from stdin, without the stream's delay. */
function type(tui: RunTui, data: string) {
	(tui as unknown as { input(data: string): void }).input(data);
}

/** What has been drawn so far, without escapes. */
function drawn(terminal: { writes: string[] }) {
	return Bun.stripANSI(terminal.writes.join(""));
}

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
		writeFileSync(pager, "#!/bin/sh\nexec sleep 5\n");
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
			type(tui, "j");
			type(tui, "l");
			// Suspended: the pager has the keys and the plain screen.
			expect(terminal.stdin.raw).toBe(false);
			expect(terminal.stdin.listenerCount("data")).toBe(0);
			tui.stop();
			// Past the pager's exit, when the TUI decides whether to take the screen back.
			await until(
				() => (tui as unknown as { pager?: unknown }).pager === undefined,
			);
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

describe("RunTui mouse", () => {
	const wheelUp = "\u001b[<64;40;10M";
	/** What is drawn once it shows `text`. */
	const frame = async (
		terminal: ReturnType<typeof fakeTerminal>,
		text: string,
	) => {
		await until(() => drawn(terminal).includes(text));
		return drawn(terminal);
	};

	it("scrolls the Overview with the wheel, and End follows the output again", async () => {
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
		try {
			tui.start();
			for (let i = 0; i < 60; i++) output.line("api", `line ${i}`);
			expect(terminal.writes.join("")).toContain("\u001b[?1000h");
			type(tui, wheelUp + wheelUp);
			expect(await frame(terminal, "↑ 6 lines")).toContain(
				"↑ 6 lines · End to follow",
			);
			terminal.writes.length = 0;
			type(tui, "\u001b[F");
			const after = await frame(terminal, "line 59");
			expect(after).not.toContain("↑ 6 lines");
			expect(after).toContain("line 59");
		} finally {
			tui.stop();
		}
		// Reporting is turned off again with the screen.
		const last = terminal.writes.join("");
		expect(last.lastIndexOf("\u001b[?1000l")).toBeGreaterThan(
			last.lastIndexOf("\u001b[?1000h"),
		);
	});

	it("selects an app clicked in the sidebar", async () => {
		const terminal = fakeTerminal();
		const tui = new RunTui({
			output: new RunOutput(),
			apps: ["api", "web"],
			urlFor: (app) => `http://${app}.test`,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		try {
			tui.start();
			// Row 1 header, 2 Overview, 3 the rule, 4 api, 5 web.
			type(tui, "\u001b[<0;3;5M\u001b[<0;3;5m");
			expect(await frame(terminal, "http://web.test")).toContain(
				"http://web.test",
			);
		} finally {
			tui.stop();
		}
	});

	it("never types mouse reports into an app in interact mode", () => {
		const forwarded: string[] = [];
		const output = new RunOutput();
		const screen = output.screen("api");
		screen.input = (data: string) => void forwarded.push(data);
		const terminal = fakeTerminal();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		try {
			tui.start();
			const input = (data: string) =>
				(tui as unknown as { input(data: string): void }).input(data);
			input("j");
			input("\r");
			input(`a${wheelUp}b`);
			input(wheelUp);
			expect(forwarded).toEqual(["ab"]);
		} finally {
			tui.stop();
		}
	});
});

describe("RunTui interact mode", () => {
	const setup = () => {
		const forwarded: string[] = [];
		let quits = 0;
		const output = new RunOutput();
		output.screen("api").input = (data: string) => void forwarded.push(data);
		const terminal = fakeTerminal();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => quits++,
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		const state = tui as unknown as {
			input(data: string): void;
			mode: { kind: string };
		};
		tui.start();
		state.input("j");
		state.input("\r");
		expect(state.mode.kind === "interact").toBe(true);
		return { tui, state, forwarded, quits: () => quits };
	};
	// Past the wait that tells a lone Esc from the start of a longer key.
	const left = (state: { mode: { kind: string } }) =>
		until(() => state.mode.kind !== "interact");

	it("leaves on a lone Esc or Ctrl-], and still sends escape sequences to the app", async () => {
		const { tui, state, forwarded } = setup();
		try {
			state.input("\u001b[A");
			state.input("\u001bb");
			state.input("\u001b");
			expect(state.mode.kind === "interact").toBe(true);
			await left(state);
			expect(state.mode.kind === "interact").toBe(false);
			expect(forwarded).toEqual(["\u001b[A", "\u001bb"]);

			state.input("\r");
			state.input("x\u001d");
			expect(state.mode.kind === "interact").toBe(false);
			expect(forwarded).toEqual(["\u001b[A", "\u001bb", "x"]);
		} finally {
			tui.stop();
		}
	});

	it("reads keys across chunk boundaries", async () => {
		const { tui, state, forwarded, quits } = setup();
		try {
			// Alt+q split in two: one key for the app, not Esc then q (quit).
			state.input("\u001b");
			state.input("q");
			// A mouse report split in two: the wheel, never typed into the app.
			state.input("\u001b[<64;");
			state.input("40;10M");
			expect(state.mode.kind === "interact").toBe(true);
			expect(quits()).toBe(0);
			expect(forwarded).toEqual(["\u001bq"]);

			// A key and Esc in one chunk: the key goes to the app, Esc leaves.
			state.input("a\u001b");
			await left(state);
			expect(forwarded).toEqual(["\u001bq", "a"]);
			expect(state.mode.kind === "interact").toBe(false);
		} finally {
			tui.stop();
		}
	});
});

describe("RunTui selection", () => {
	const press = (col: number, row: number) => `\u001b[<0;${col};${row}M`;
	const drag = (col: number, row: number) => `\u001b[<32;${col};${row}M`;
	const release = (col: number, row: number) => `\u001b[<0;${col};${row}m`;

	it("copies a drag in the Overview as whole lines, and highlights it", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			output.line("api", "first line");
			output.line("api", `second ${"x".repeat(200)} end`);
			// 80x20 terminal: sidebar 1-18, divider 19, the pane from column 20 and rows 2..19; the two
			// lines sit on the last two pane rows.
			type(tui, press(20, 18) + drag(80, 19) + release(80, 19));
			expect(copied).toHaveLength(1);
			const [first, second] = (copied[0] ?? "").split("\n");
			expect(first).toMatch(/^\d\d:\d\d:\d\d api {7}first line$/);
			// Dragged to the edge: the cut-off line is copied in full.
			expect(second).toEndWith(`${"x".repeat(200)} end`);
			await until(() => drawn(terminal).includes("Copied 2 lines"));

			// Stopping mid-line copies only up to there.
			type(tui, press(20, 19) + drag(39, 19) + release(39, 19));
			expect(copied[1]).toMatch(/^\d\d:\d\d:\d\d api {7}s$/);
			expect(copied[1]?.length).toBe(20);
			expect(terminal.writes.join("")).toContain("\u001b[7m");
			expect(drawn(terminal)).toContain("Copied 2 lines");
		} finally {
			tui.stop();
		}
	});

	it("copies from an app's own terminal", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			const screen = output.screen("api");
			await new Promise<void>((resolve) =>
				screen.term.write("alpha beta\r\ngamma delta\r\n", resolve),
			);
			type(tui, press(3, 4) + release(3, 4)); // select api
			type(tui, press(26, 2) + drag(24, 3) + release(24, 3));
			expect(copied).toEqual(["beta\ngamma"]);
		} finally {
			tui.stop();
		}
	});

	it("copies lines the app wrapped itself as one line each", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			const screen = output.screen("api");
			// Wrapped the way Ink wraps at the 61-column pane, one column of
			// padding on each side.
			const rows = [
				" Your app is running. Press p to open the preview in the",
				" browser.",
				" Preview URL: https://admin.shopify.com/store/s/apps/bb99c65",
				" 43038?dev-console=show",
				" GraphiQL URL: http://localhost:3457/graphiql",
			];
			await new Promise<void>((resolve) =>
				screen.term.write(`${rows.join("\r\n")}\r\n`, resolve),
			);
			type(tui, press(3, 4) + release(3, 4)); // select api
			type(tui, press(20, 2) + drag(80, 6) + release(80, 6));
			expect(copied).toEqual([
				[
					" Your app is running. Press p to open the preview in the browser.",
					" Preview URL: https://admin.shopify.com/store/s/apps/bb99c6543038?dev-console=show",
					" GraphiQL URL: http://localhost:3457/graphiql",
				].join("\n"),
			]);
			await until(() => drawn(terminal).includes("Copied 3 lines"));
			expect(drawn(terminal)).toContain("Copied 3 lines");
		} finally {
			tui.stop();
		}
	});

	it("keeps the lines of an app the terminal had to wrap", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			const screen = output.screen("api");
			// Wider than the 61-column pane, so the terminal wraps it, and its
			// last row ends close enough to the edge to look wrapped by the app.
			const long = `request ${"x".repeat(50)} ${"y".repeat(57)}`;
			await new Promise<void>((resolve) =>
				screen.term.write(`${long}\r\ndone\r\n`, resolve),
			);
			type(tui, press(3, 4) + release(3, 4)); // select api
			type(tui, press(20, 2) + drag(80, 4) + release(80, 4));
			expect(copied).toEqual([`${long}\ndone`]);
		} finally {
			tui.stop();
		}
	});

	it("ends a selection where the button is released", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			output.line("api", "only line");
			// No motion report between press and release.
			type(tui, press(20, 19) + release(39, 19));
			expect(copied[0]).toMatch(/^\d\d:\d\d:\d\d api {7}o$/);
			// The highlight is in the pane, not the sidebar's selected row.
			const highlighted = () =>
				terminal.writes
					.join("")
					// biome-ignore lint/suspicious/noControlCharactersInRegex: cursor moves
					.split(/\u001b\[\d+;1H/)
					.map((row) => row.split("│").slice(1).join("│"))
					.some((row) => row.includes("\u001b[7m"));
			await until(highlighted);
			expect(highlighted()).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("copies the lines it selected after the Overview drops old ones", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			for (let i = 0; i < 10_000; i++) output.line("api", `line-${i}`);
			// The last line, from the start of its text to its end.
			type(tui, press(39, 19) + drag(80, 19));
			output.line("api", "line-new");
			type(tui, release(80, 19));
			expect(copied).toEqual(["line-9999"]);
		} finally {
			tui.stop();
		}
	});

	it("copies the rows it selected after the app's scrollback trims", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		const write = (text: string) =>
			new Promise<void>((resolve) => screen.term.write(text, resolve));
		const screen = output.screen("api");
		try {
			tui.start();
			let text = "";
			for (let i = 0; i < 10_100; i++) text += `app-${i}\r\n`;
			await write(text);
			type(tui, press(3, 4) + release(3, 4)); // select api
			// The top pane row, whole.
			type(tui, press(20, 2) + drag(80, 2));
			const top = screen.term.buffer.active.getLine(
				screen.term.buffer.active.baseY,
			);
			const selected = top?.translateToString(true);
			await write("more\r\n");
			type(tui, release(80, 2));
			expect(copied).toEqual([selected ?? ""]);

			// The app switching screens under a drag ends it: nothing is copied.
			type(tui, press(20, 2) + drag(80, 3));
			await write("\u001b[?1049h");
			type(tui, release(80, 3));
			expect(copied).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});

	it("treats a click without a drag as no selection", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			output.line("api", "only line");
			type(tui, press(30, 19) + release(30, 19));
			expect(copied).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("ends a selection begun in interact mode when a key is typed", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const screen = output.screen("api");
		const tui = new RunTui({
			output,
			apps: ["api"],
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		try {
			tui.start();
			await new Promise<void>((resolve) =>
				screen.term.write("alpha beta\r\ngamma delta\r\n", resolve),
			);
			screen.input = () => {};
			type(tui, "j\r");
			type(tui, press(26, 2) + drag(24, 3));
			type(tui, "x");
			type(tui, release(24, 3));
			expect(copied).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});

describe("RunTui state", () => {
	const wheelUp = "\u001b[<64;40;10M";
	const setup = (apps = ["api"]) => {
		const terminal = fakeTerminal();
		const output = new RunOutput();
		const tui = new RunTui({
			output,
			apps,
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: () => "clipboard",
		});
		/** The frame drawn once it shows `text`, from the writes after `since`. */
		const frame = async (text: string, since = 0) => {
			const after = () => Bun.stripANSI(terminal.writes.slice(since).join(""));
			await until(() => after().includes(text));
			return after();
		};
		return { terminal, output, tui, frame };
	};
	const write = (output: RunOutput, text: string) =>
		new Promise<void>((resolve) =>
			output.screen("api").term.write(text, resolve),
		);
	const lines = (from: number, count: number) =>
		Array.from({ length: count }, (_, i) => `row-${from + i}\r\n`).join("");

	it("gives the terminal its own writes back after a second start", () => {
		const { tui } = setup();
		const write = process.stdout.write;
		tui.start();
		tui.start();
		tui.stop();
		expect(process.stdout.write).toBe(write);
	});

	it("stops sizing app terminals to its pane once stopped", () => {
		const { tui, output } = setup();
		tui.start();
		expect(output.terminalSize).toBeDefined();
		tui.stop();
		expect(output.terminalSize).toBeUndefined();
	});

	// `r` before the spawner has bound its controls restarts nothing.
	it("says an app cannot restart yet rather than that it is restarting", async () => {
		const { tui, frame } = setup();
		try {
			tui.start();
			type(tui, "j");
			type(tui, "r");
			expect(await frame("cannot restart")).not.toContain("Restarting api");
		} finally {
			tui.stop();
		}
	});

	it("shows the interact footer again once a key is typed after a copy", async () => {
		const { tui, output, terminal, frame } = setup();
		output.screen("api").input = () => {};
		try {
			tui.start();
			await write(output, "alpha beta\r\ngamma delta\r\n");
			type(tui, "j\r");
			type(
				tui,
				"\u001b[<0;26;2M\u001b[<32;24;3M\u001b[<0;24;3m", // drag to copy
			);
			await frame("Copied");
			const since = terminal.writes.length;
			type(tui, "x");
			expect(await frame("interacting with api", since)).toContain(
				"interacting with api",
			);
		} finally {
			tui.stop();
		}
	});

	it("goes back to the live bottom when keys are typed into an app scrolled back", async () => {
		const { tui, output, terminal, frame } = setup();
		const typed: string[] = [];
		output.screen("api").input = (data: string) => void typed.push(data);
		try {
			tui.start();
			await write(output, lines(0, 100));
			type(tui, "j");
			type(tui, wheelUp);
			await frame("↑ 3 lines");
			type(tui, "\r");
			const since = terminal.writes.length;
			type(tui, "x");
			expect(typed).toEqual(["x"]);
			expect(await frame("keys go to the app", since)).not.toContain("↑");
		} finally {
			tui.stop();
		}
	});

	// The Overview already kept its place; an app's pane slid with each line.
	it("keeps a scrolled-back app pane on the same text as the app prints", async () => {
		const { tui, output, terminal, frame } = setup();
		/** The text on the pane's top row as last drawn. */
		const topRow = () =>
			/row-\d+/.exec(
				Bun.stripANSI((tui as unknown as { frame: string[] }).frame[1] ?? ""),
			)?.[0];
		try {
			tui.start();
			await write(output, lines(0, 100));
			type(tui, "j");
			type(tui, wheelUp);
			await frame("↑ 3 lines");
			const top = topRow();
			expect(top).toBeDefined();
			const since = terminal.writes.length;
			await write(output, lines(100, 5));
			await frame("↑ 8 lines", since);
			expect(topRow()).toBe(top);
		} finally {
			tui.stop();
		}
	});

	it("marks only apps unread, never buncargo's own lines", () => {
		const { tui, output } = setup();
		try {
			tui.start();
			output.line("buncargo", "error: something buncargo said");
			output.line("api", "error: the api failed");
			const { unread } = tui as unknown as { unread: Set<string> };
			expect([...unread]).toEqual(["api"]);
		} finally {
			tui.stop();
		}
	});

	// A SIGINT listener added while the pager was open sat next to the
	// pager's own, and the Ctrl-C that closes the pager fired it.
	it("holds a SIGINT listener added while the pager is open until it closes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tui-pager-added-"));
		const saved = process.env.PAGER;
		const pager = join(dir, "pager.sh");
		writeFileSync(pager, "#!/bin/sh\nexec sleep 5\n");
		chmodSync(pager, 0o755);
		process.env.PAGER = pager;
		const terminal = fakeTerminal();
		const tui = new RunTui({
			output: new RunOutput(),
			apps: ["api"],
			urlFor: () => undefined,
			logPath: () => join(dir, "api.log"),
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		const added = () => {};
		const addedOnce = () => {};
		const addedAndRemoved = () => {};
		try {
			tui.start();
			type(tui, "j");
			type(tui, "l");
			await until(
				() => (tui as unknown as { pager?: unknown }).pager !== undefined,
			);
			process.on("SIGINT", added);
			process.once("SIGINT", addedOnce);
			process.on("SIGINT", addedAndRemoved);
			process.off("SIGINT", addedAndRemoved);
			expect(process.listeners("SIGINT")).not.toContain(added);
			expect(process.listeners("SIGINT")).not.toContain(addedOnce);
			tui.stop();
			await until(
				() => (tui as unknown as { pager?: unknown }).pager === undefined,
			);
			expect(process.listeners("SIGINT")).toContain(added);
			expect(process.listeners("SIGINT")).toContain(addedOnce);
			expect(process.listeners("SIGINT")).not.toContain(addedAndRemoved);
		} finally {
			tui.stop();
			process.off("SIGINT", added);
			process.off("SIGINT", addedOnce);
			process.off("SIGINT", addedAndRemoved);
			if (saved === undefined) delete process.env.PAGER;
			else process.env.PAGER = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The pager holds the run's SIGINT listeners aside: one removed meanwhile
	// (the run ended while it was open) must not come back when it closes.
	it("does not put back a SIGINT listener removed while the pager was open", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tui-pager-held-"));
		const saved = process.env.PAGER;
		const pager = join(dir, "pager.sh");
		writeFileSync(pager, "#!/bin/sh\nexec sleep 5\n");
		chmodSync(pager, 0o755);
		process.env.PAGER = pager;
		const terminal = fakeTerminal();
		const tui = new RunTui({
			output: new RunOutput(),
			apps: ["api"],
			urlFor: () => undefined,
			logPath: () => join(dir, "api.log"),
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		const ended = () => {};
		const kept = () => {};
		process.on("SIGINT", ended);
		process.on("SIGINT", kept);
		try {
			tui.start();
			type(tui, "j");
			type(tui, "l");
			await until(
				() => (tui as unknown as { pager?: unknown }).pager !== undefined,
			);
			process.off("SIGINT", ended);
			tui.stop();
			await until(
				() => (tui as unknown as { pager?: unknown }).pager === undefined,
			);
			expect(process.listeners("SIGINT")).not.toContain(ended);
			expect(process.listeners("SIGINT")).toContain(kept);
		} finally {
			tui.stop();
			process.off("SIGINT", ended);
			process.off("SIGINT", kept);
			if (saved === undefined) delete process.env.PAGER;
			else process.env.PAGER = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
