import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { RunOutput, type StartReply } from "../../core/process/run-output";
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
		const output = new RunOutput({ terminals: "pipe" });
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
			output: new RunOutput({ terminals: "pipe" }),
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
		const output = new RunOutput({ terminals: "pipe" });
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
			output: new RunOutput({ terminals: "pipe" }),
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
		const output = new RunOutput({ terminals: "pipe" });
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
			type(tui, "j");
			type(tui, "\r");
			type(tui, `a${wheelUp}b`);
			type(tui, wheelUp);
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
		const output = new RunOutput({ terminals: "pipe" });
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

	/** A TUI on a fake terminal whose copies are collected in `copied`. */
	function selectionHarness() {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput({ terminals: "pipe" });
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
		return { copied, terminal, output, tui };
	}

	it("copies a drag in the Overview as whole lines, and highlights it", async () => {
		const { copied, terminal, output, tui } = selectionHarness();
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
		const { copied, output, tui } = selectionHarness();
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
		const { copied, terminal, output, tui } = selectionHarness();
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
		const { copied, output, tui } = selectionHarness();
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
		const { copied, terminal, output, tui } = selectionHarness();
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
		const { copied, output, tui } = selectionHarness();
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
		const { copied, output, tui } = selectionHarness();
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
		const { copied, output, tui } = selectionHarness();
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
		const { copied, output, tui } = selectionHarness();
		const screen = output.screen("api");
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

	it("copies the exact text selected on a wrapped Overview continuation row", async () => {
		const { copied, terminal, output, tui } = selectionHarness();
		try {
			tui.start();
			const pad = "x".repeat(45);
			output.line("api", `${pad}TARGET_TOKEN`);
			const since = terminal.writes.length;
			type(tui, "w");
			await until(() =>
				Bun.stripANSI(terminal.writes.slice(since).join("")).includes(
					"Line wrap on",
				),
			);
			await until(() => drawn(terminal).includes("TARGET_TOKEN"));

			const paneStart = 18 + 2;
			const frameRows = (tui as unknown as { frame: string[] }).frame;
			const continuationRow = frameRows.findIndex((row) =>
				Bun.stripANSI(row).includes("TARGET_TOKEN"),
			);
			expect(continuationRow).toBeGreaterThanOrEqual(2);
			const stripped = Bun.stripANSI(frameRows[continuationRow] ?? "");
			const startCol = stripped.indexOf("TARGET_TOKEN") - (paneStart - 1);
			const endCol = startCol + "TARGET_TOKEN".length - 1;
			type(
				tui,
				press(paneStart + startCol, continuationRow + 1) +
					drag(paneStart + endCol, continuationRow + 1) +
					release(paneStart + endCol, continuationRow + 1),
			);
			expect(copied).toEqual(["TARGET_TOKEN"]);
		} finally {
			tui.stop();
		}
	});
});

describe("RunTui state", () => {
	const wheelUp = "\u001b[<64;40;10M";
	const setup = (apps = ["api"]) => {
		const terminal = fakeTerminal();
		const output = new RunOutput({ terminals: "pipe" });
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
		expect(output.screenSize()).toEqual(tui.paneSize());
		tui.stop();
		expect(output.screenSize()).toEqual({ cols: 80, rows: 24 });
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
			output: new RunOutput({ terminals: "pipe" }),
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
			output: new RunOutput({ terminals: "pipe" }),
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

	it("renders reactive task panes with `r run`, disables interact mode, and triggers on `r`", async () => {
		const terminal = fakeTerminal();
		const output = new RunOutput({ terminals: "pipe" });
		const triggered: string[] = [];
		output.controls = {
			restart: async (name) => {
				triggered.push(name);
				return true;
			},
			stop: async () => false,
		};
		output.state("gen:client", {
			state: "stopped",
			detail: "idle",
			restartable: true,
			rerunCommand: "buncargo run gen:client",
		});
		const tui = new RunTui({
			output,
			apps: ["api", "gen:client"],
			taskNames: new Set(["gen:client"]),
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		const state = tui as unknown as { mode: { kind: string } };
		try {
			tui.start();
			// Move from Overview -> api -> gen:client.
			type(tui, "jj");
			await until(() => drawn(terminal).includes("r run"));
			const view = drawn(terminal);
			expect(view).toContain("idle");
			expect(view).toContain("r run");
			expect(view).not.toContain("enter interact");

			// Enter does not open interact mode on a task pane.
			type(tui, "\r");
			expect(state.mode.kind).toBe("navigate");

			// Pressing `r` runs the task and flashes "Running gen:client…".
			const since = terminal.writes.length;
			type(tui, "r");
			await until(() =>
				Bun.stripANSI(terminal.writes.slice(since).join("")).includes(
					"Running gen:client…",
				),
			);
			expect(triggered).toEqual(["gen:client"]);
		} finally {
			tui.stop();
		}
	});
	it("lists an app the run left out as not started, and starts it on `r` or `s`", async () => {
		const terminal = fakeTerminal();
		const output = new RunOutput({ terminals: "pipe" });
		output.state("api", { state: "ready" });
		const started: string[] = [];
		const answers: StartReply[] = [
			{
				status: "refused",
				reason:
					"mobile needs redis, which this run did not start.\nThe rest of it.",
			},
			{ status: "started", apps: ["metro", "mobile"] },
		];
		const tui = new RunTui({
			output,
			apps: ["api", "mobile"],
			leftOut: new Set(["mobile"]),
			urlFor: (app) => `https://${app}.shop.localhost`,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		const footerAfter = async (since: number, text: string) =>
			until(() =>
				Bun.stripANSI(terminal.writes.slice(since).join("")).includes(text),
			);
		try {
			tui.start();
			type(tui, "jj");
			await until(() => drawn(terminal).includes("r start"));
			const view = drawn(terminal);
			expect(view).toContain("off");
			expect(view).toContain("mobile is not part of this run yet");
			expect(view).not.toContain("https://mobile.shop.localhost");
			expect(view).not.toContain("enter interact");

			// Before the run binds the start: says so, starts nothing.
			let since = terminal.writes.length;
			type(tui, "r");
			await footerAfter(since, "can start once the run's own apps are up");

			output.startApp = async (name) => {
				started.push(name);
				return answers.shift() ?? { status: "started", apps: [name] };
			};
			since = terminal.writes.length;
			type(tui, "r");
			await footerAfter(
				since,
				"mobile needs redis, which this run did not start.",
			);

			// Pressing `s` on a left-out `off` app starts it just like `r`.
			since = terminal.writes.length;
			type(tui, "s");
			await footerAfter(since, "Starting metro, mobile…");
			expect(started).toEqual(["mobile", "mobile"]);

			// Started: an app like any other, restarted by `r`. Any key (a
			// redraw here) ends the message the footer shows meanwhile.
			output.state("mobile", { state: "starting" });
			since = terminal.writes.length;
			type(tui, "\u000c");
			await footerAfter(since, "r restart");
		} finally {
			tui.stop();
		}
	});

	it("preserves multi-line structured error blocks and stack frames under `e` errors-only", async () => {
		const { tui, output, terminal, frame } = setup(["api"]);
		try {
			tui.start();
			output.line("api", "[INFO] request.start {");
			output.line("api", '  error_type: "none",');
			output.line("api", "}");
			output.line("api", "[ERROR] job.failed {");
			output.line("api", "  id: 42,");
			output.line("api", "}");
			output.line("api", "Error: boom");
			output.line("api", "    at handleRequest (src/server.ts:12:5)");
			output.line("api", "GET /health 200");

			const since = terminal.writes.length;
			type(tui, "e");
			const view = await frame("errors and warnings only", since);
			expect(view).toContain("id: 42");
			expect(view).toContain("at handleRequest");
			expect(view).not.toContain("GET /health 200");
			expect(view).not.toContain('error_type: "none"');
		} finally {
			tui.stop();
		}
	});

	it("supports live `/` search in Overview and app panes with `n`/`N` and `Esc`", async () => {
		const { tui, output, terminal, frame } = setup(["api"]);
		try {
			tui.start();
			output.line("api", "booted ok");
			output.line("api", "invoice #991 created");
			output.line("api", "health check ok");

			// Overview search filters and highlights matches.
			let since = terminal.writes.length;
			type(tui, "/invoice\r");
			const overviewHit = await frame("/invoice (1 matches)", since);
			expect(overviewHit).toContain("invoice #991");
			expect(overviewHit).not.toContain("health check ok");

			// Esc clears search while staying in Overview.
			since = terminal.writes.length;
			type(tui, "\u001b");
			const cleared = await frame("health check ok", since);
			expect(cleared).not.toContain("/invoice");

			// App pane search scans xterm buffer and steps with n/N.
			await write(
				output,
				`${lines(0, 30)}needle-early\r\n${lines(30, 40)}needle-late\r\n`,
			);
			type(tui, "1");
			since = terminal.writes.length;
			type(tui, "/needle\r");
			const appHit = await frame("/needle (2/2)", since);
			expect(appHit).toContain("needle-late");

			since = terminal.writes.length;
			type(tui, "n");
			const olderHit = await frame("/needle (1/2)", since);
			expect(olderHit).toContain("needle-early");

			// First Esc clears search without leaving the api pane.
			since = terminal.writes.length;
			type(tui, "\u001b");
			await until(
				() =>
					!Bun.stripANSI(
						(tui as unknown as { frame: string[] }).frame[0] ?? "",
					).includes("/needle"),
			);
			expect(
				Bun.stripANSI((tui as unknown as { frame: string[] }).frame[0] ?? ""),
			).toContain("api");
		} finally {
			tui.stop();
		}
	});

	it("toggles stop/start with `s` and reports reused or failed restart/stop outcomes", async () => {
		const { tui, output, terminal, frame } = setup(["api", "reused"]);
		const events: string[] = [];
		output.state("api", { state: "ready" });
		output.state("reused", { state: "ready" });
		output.controls = {
			restart: async (name) => {
				events.push(`restart:${name}`);
				if (name === "reused") return false;
				output.state(name, { state: "ready" });
				return true;
			},
			stop: async (name) => {
				events.push(`stop:${name}`);
				if (name === "reused") return false;
				output.state(name, { state: "stopped", detail: "stopped" });
				return true;
			},
		};
		try {
			tui.start();
			type(tui, "1"); // jump to api
			let since = terminal.writes.length;
			type(tui, "s");
			await frame("Stopped api", since);
			expect(events).toEqual(["stop:api"]);

			// Pressing `s` while stopped starts it back up.
			since = terminal.writes.length;
			type(tui, "s");
			await frame("Starting api…", since);
			expect(events).toEqual(["stop:api", "restart:api"]);

			// Reused app reports honest refusal on `r` and `s`.
			type(tui, "2"); // jump to reused
			since = terminal.writes.length;
			type(tui, "r");
			await frame("reused from another terminal", since);
			since = terminal.writes.length;
			type(tui, "s");
			await frame("reused from another terminal", since);
		} finally {
			tui.stop();
		}
	});

	it("supports clear (`c`), copy URL (`y`), wrap (`w`), sidebar toggle (`b`), info (`i`), and gives declared actions priority over `g`", async () => {
		const copied: string[] = [];
		const terminal = fakeTerminal();
		const output = new RunOutput({ terminals: "pipe" });
		const tui = new RunTui({
			output,
			apps: ["api", "web"],
			profile: "local",
			info: () => [" Custom Env Line: postgres:5432"],
			urlFor: (app) => `https://${app}.myapp.localhost`,
			actions: [{ app: "api", key: "g", label: "GraphiQL", open: "graphiql" }],
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
			copy: (text) => {
				copied.push(text);
				return "clipboard";
			},
		});
		const frame = async (text: string, since = 0) => {
			const after = () => Bun.stripANSI(terminal.writes.slice(since).join(""));
			await until(() => after().includes(text));
			return after();
		};
		try {
			tui.start();
			output.line("api", "hello before clear");
			output.capture("api", {
				name: "graphiql",
				value: "https://graphiql.example.test",
				as: "value",
			});

			// Profile badge and DEC 2026 sync markers appear in rendered frames.
			await frame("hello before clear");
			expect(terminal.writes.join("")).toContain("\u001b[?2026h");
			expect(drawn(terminal)).toContain("local");

			// `w` toggles soft wrap.
			let since = terminal.writes.length;
			type(tui, "w");
			await frame("Line wrap on", since);

			// `c` clears Overview.
			since = terminal.writes.length;
			type(tui, "c");
			await frame("Cleared Overview", since);
			expect((tui as unknown as { lines: unknown[] }).lines).toHaveLength(0);

			// `b` collapses sidebar and widens paneSize().
			const widthWithSidebar = tui.paneSize().cols;
			type(tui, "b");
			expect(tui.paneSize().cols).toBeGreaterThan(widthWithSidebar);
			type(tui, "[");
			expect(tui.paneSize().cols).toBe(widthWithSidebar);

			// `i` opens info overlay with env summary + keybindings, and `i` closes it.
			since = terminal.writes.length;
			type(tui, "i");
			const infoView = await frame("Custom Env Line: postgres:5432", since);
			expect(infoView).toContain("Keybindings");
			type(tui, "i");

			// `2` jumps straight to `web` and `y` copies its URL.
			type(tui, "2");
			since = terminal.writes.length;
			type(tui, "y");
			await frame("Copied web URL", since);
			expect(copied).toEqual(["https://web.myapp.localhost"]);

			// Declared action `g` wins over scroll-to-top `g`.
			since = terminal.writes.length;
			type(tui, "g");
			await frame("graphiql.example.test", since);
		} finally {
			tui.stop();
		}
	});

	it("skips redrawing an active app pane when an unrelated background app prints", async () => {
		const { tui, output, frame } = setup(["api", "worker"]);
		const internal = tui as unknown as {
			dirty: boolean;
			timer?: ReturnType<typeof setTimeout>;
		};
		try {
			tui.start();
			await write(output, "api ready\r\n");
			type(tui, "1"); // view api
			await frame("api ready");
			expect(internal.dirty).toBe(false);
			expect(internal.timer).toBeUndefined();

			// Ordinary background output does not schedule a redraw while viewing `api`.
			output.line("worker", "background info line 1");
			output.line("worker", "background info line 2");
			expect(internal.dirty).toBe(false);
			expect(internal.timer).toBeUndefined();

			// A new error in the background flips its unread `!` badge and triggers a redraw.
			output.line("worker", "Error: background boom");
			expect(internal.dirty).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("opens a chronologically merged log file in $PAGER when `l` is pressed in Overview", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tui-merged-log-"));
		const saved = process.env.PAGER;
		const capturedFile = join(dir, "captured.txt");
		const pager = join(dir, "pager.sh");
		writeFileSync(
			pager,
			`#!/bin/sh\ncp "$1" ${JSON.stringify(capturedFile)}\n`,
		);
		chmodSync(pager, 0o755);
		writeFileSync(
			join(dir, "api.log"),
			"2026-11-27T10:00:01.000Z api first\n2026-11-27T10:00:03.000Z api third\n",
		);
		writeFileSync(
			join(dir, "web.log"),
			"2026-11-27T10:00:02.000Z web second\n",
		);
		process.env.PAGER = pager;
		const terminal = fakeTerminal();
		const tui = new RunTui({
			output: new RunOutput({ terminals: "pipe" }),
			apps: ["api", "web"],
			urlFor: () => undefined,
			logPath: () => dir,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		try {
			tui.start();
			type(tui, "l");
			await until(() => {
				try {
					return Bun.file(capturedFile).size > 0;
				} catch {
					return false;
				}
			});
			const merged = await Bun.file(capturedFile).text();
			const rows = merged.trim().split("\n");
			expect(rows[0]).toContain("api");
			expect(rows[0]).toContain("api first");
			expect(rows[1]).toContain("web");
			expect(rows[1]).toContain("web second");
			expect(rows[2]).toContain("api third");
		} finally {
			tui.stop();
			if (saved === undefined) delete process.env.PAGER;
			else process.env.PAGER = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps exact frame dimensions on narrow/short terminals and caches info overlay reads", async () => {
		let infoCalls = 0;
		const terminal = fakeTerminal();
		terminal.stdout.columns = 32;
		terminal.stdout.rows = 4;
		const output = new RunOutput({ terminals: "pipe" });
		const tui = new RunTui({
			output,
			apps: ["api", "web"],
			info: () => {
				infoCalls++;
				return [" Env summary line"];
			},
			urlFor: () => undefined,
			quit: () => {},
			stdin: terminal.stdin,
			stdout: terminal.stdout,
		});
		const frame = async (text: string, since = 0) => {
			const after = () => Bun.stripANSI(terminal.writes.slice(since).join(""));
			await until(() => after().includes(text));
			return after();
		};
		try {
			tui.start();
			output.line("web", "narrow boot");
			await frame("narrow boot");
			const rows = (tui as unknown as { frame: string[] }).frame;
			expect(rows).toHaveLength(4);
			for (const row of rows) {
				expect(Bun.stringWidth(row)).toBe(32);
			}
			// Footer is preserved at row 3 even when terminal height is 4.
			expect(Bun.stripANSI(rows[3] ?? "")).toContain("select");

			// Info overlay caches `info()` instead of calling it on every log line.
			const since = terminal.writes.length;
			type(tui, "i");
			await frame("Env summary line", since);
			const callsAfterOpen = infoCalls;
			output.line("web", "chatter 1");
			output.line("web", "chatter 2");
			expect(infoCalls).toBe(callsAfterOpen);
		} finally {
			tui.stop();
		}
	});
});
