import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnoredChange } from "./app-watch";
import { startDevServers, stopDevServers } from "./dev-servers";
import { RunOutput } from "./run-output";

describe("isIgnoredChange", () => {
	it("ignores dependencies and the app's own globs", () => {
		expect(isIgnoredChange("node_modules/x/index.js")).toBe(true);
		expect(isIgnoredChange("src/node_modules/x.js")).toBe(true);
		expect(isIgnoredChange("dist/server.js", ["dist/**"])).toBe(true);
		expect(isIgnoredChange("dist", ["dist/**"])).toBe(true);
		expect(isIgnoredChange("src/routes/a.ts", ["dist/**"])).toBe(false);
	});
});

describe("startDevServers watch", () => {
	it("restarts an app with a fresh process when a watched file changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-watch-"));
		await mkdir(join(root, "api/src"), { recursive: true });
		await mkdir(join(root, "api/dist"), { recursive: true });
		const output = new RunOutput();
		output.terminalSize = () => ({ cols: 80, rows: 10 });
		const restarts: string[] = [];
		output.subscribe({
			line: (line) => {
				if (line.event && line.text.startsWith("restarting"))
					restarts.push(`${line.app}: ${line.text}`);
			},
		});
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					api: {
						kind: "worker",
						cwd: "api",
						watch: { paths: ["src", "dist"], ignore: ["dist/**"] },
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
				},
				root,
				{},
				{},
				{ verbose: false, waitForExit: false, output },
			);
			const first = pids.api;

			// An ignored path changes nothing.
			await writeFile(join(root, "api/dist/out.js"), "1");
			await Bun.sleep(400);
			expect(pids.api).toBe(first);

			await writeFile(join(root, "api/src/index.ts"), "export {}");
			for (let i = 0; i < 100 && pids.api === first; i++) await Bun.sleep(30);
			expect(pids.api).not.toBe(first);
			expect(restarts).toEqual(["api: restarting: src/index.ts changed"]);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);
});
