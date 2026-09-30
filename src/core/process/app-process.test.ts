import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../shell-quote";
import { spawnManagedApp } from "./app-process";
import { spawnDevServer } from "./dev-servers";

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
				prefixWidth: 3,
				onFirstLog: () => {},
			},
		);
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

it("runs quoted shell commands through the legacy spawn export", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo legacy shell "));
	try {
		const child = await spawnDevServer(
			"printf '%s' 'two words' > result.txt",
			root,
			undefined,
			{},
			{ killExisting: false, detached: false },
		);
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => resolve());
		});
		expect(readFileSync(join(root, "result.txt"), "utf8")).toBe("two words");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
