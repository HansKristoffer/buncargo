import { expect, it } from "bun:test";
import type { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../shell-quote";
import { AppLogs } from "./app-logs";
import { spawnManagedApp } from "./app-process";
import { printStream, RunOutput } from "./run-output";

it("passes attached arguments literally, including shell syntax and empty values", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo literal args "));
	const script = join(root, "record args.ts");
	writeFileSync(
		script,
		"await Bun.write('args.json', JSON.stringify(process.argv.slice(2)));",
	);
	const args = [
		"two words",
		"",
		"'quoted'",
		'"double"',
		"$(echo substituted)",
		"; echo injected",
		"*.ts",
		"a\\b",
		"--flag=value",
	];
	try {
		const child = spawnManagedApp(
			"web",
			{
				port: 3000,
				devCommand: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
			},
			root,
			{},
			{
				attached: true,
				extraArgs: args,
				productionBuild: false,
				waitForExit: true,
				output: new RunOutput(),
			},
		) as EventEmitter;
		const code = await new Promise((resolve, reject) => {
			child.once("exit", resolve);
			child.once("error", reject);
		});
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "args.json"), "utf8"))).toEqual(
			args,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("gives an attached app without a terminal one of its own: printed once, logged", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo attached log "));
	try {
		const logs = new AppLogs(root, "attached");
		const output = new RunOutput(logs);
		let printed = "";
		printStream(output, {
			width: 3,
			write: (text) => {
				printed += text;
			},
		});
		const child = spawnManagedApp(
			"web",
			{ port: 3000, devCommand: "echo hello from web" },
			root,
			{},
			{
				attached: true,
				extraArgs: [],
				productionBuild: false,
				waitForExit: true,
				output,
			},
		) as EventEmitter;
		await new Promise((resolve) => child.once("exit", resolve));
		await Bun.sleep(50);
		output.close();
		expect(readFileSync(logs.file("web"), "utf8")).toContain("hello from web");
		// Through the screen and the stream printer, never also raw.
		expect(printed.split("hello from web")).toHaveLength(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
