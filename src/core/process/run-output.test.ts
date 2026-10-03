import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogs, listRunLogDirs } from "./app-logs";
import {
	lastErrorLines,
	lineLevel,
	printStream,
	RunOutput,
} from "./run-output";

const plain = (text: string) => Bun.stripANSI(text);

describe("RunOutput", () => {
	it("writes plain lines and run events to the app's log file", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-run-output-"));
		try {
			const logs = new AppLogs(root, "session-1234");
			const output = new RunOutput(logs);
			output.line("api", "\u001b[32mlistening\u001b[0m on 3000");
			output.line("api", "   ");
			output.state("api", { state: "failed", detail: "exit 1" });
			output.close();
			const lines = readFileSync(logs.file("api"), "utf8").trim().split("\n");
			expect(lines.map((line) => line.slice(25))).toEqual([
				"listening on 3000",
				"[buncargo] failed (exit 1)",
			]);
			expect(listRunLogDirs(root)).toEqual([logs.dir]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps only the last ten runs' logs", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-run-logs-"));
		try {
			for (let index = 0; index < 12; index++)
				new AppLogs(
					root,
					`s${index}`,
					new Date(Date.UTC(2026, 0, 1, 0, index)),
				);
			const dirs = listRunLogDirs(root);
			expect(dirs).toHaveLength(10);
			expect(dirs[0]).toEndWith("-s2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("orders runs started within the same second by start time", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-run-logs-ms-"));
		try {
			const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
			new AppLogs(root, "zzzz-older", at(100));
			const newer = new AppLogs(root, "aaaa-newer", at(900));
			expect(listRunLogDirs(root).at(-1)).toBe(newer.dir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints a stopped non-essential app with its errors and how to restart it", () => {
		const output = new RunOutput();
		let printed = "";
		printStream(output, {
			width: 7,
			write: (text) => {
				printed += text;
			},
		});
		output.line("shopify", "compiling extension");
		output.line("shopify", "Error: extension build failed");
		output.state("shopify", {
			state: "failed",
			detail: "exit 1",
			restartable: true,
		});
		output.state("api", { state: "failed", detail: "exit 1" });
		const text = plain(printed);
		expect(text).toContain("➜  shopify  compiling extension");
		expect(text).toContain(
			"shopify failed (exit 1); the rest of the run keeps going",
		);
		expect(text).toContain("Error: extension build failed");
		expect(text).toContain("buncargo restart shopify");
		// An essential app's failure ends the run; the run reports that itself.
		expect(text).not.toContain("api failed");
	});

	it("reads levels and picks the error lines of a tail", () => {
		expect(lineLevel("✗ Build failed")).toBe("error");
		expect(lineLevel("Warning: deprecated")).toBe("warn");
		expect(lineLevel("GET / 200")).toBeUndefined();
		expect(lastErrorLines(["a", "Error: x", "b"])).toEqual(["Error: x"]);
		expect(lastErrorLines(["a", "b"])).toEqual(["a", "b"]);
	});
});
