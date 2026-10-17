import { expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { listRunLogDirs } from "../core/process/app-logs";
import { standInForWatchdog } from "../core/watchdog.testing";
import { parallelSeedFixture } from "../environment/parallel-seed.testing";

it.each([
	[false, false],
	[false, true],
	[true, false],
	[true, true],
])(
	"CLI overlaps seed and apps and joins readiness (failed seed=%s, color=%s)",
	async (failSeed, color) => {
		const fixture = await parallelSeedFixture({ beforeApps: false, failSeed });
		await standInForWatchdog(fixture.root);
		const child = Bun.spawn(
			[
				process.execPath,
				resolve(import.meta.dir, "bin.ts"),
				"dev",
				"--no-hosts",
				"--timing-json",
			],
			{
				cwd: fixture.root,
				env: {
					...process.env,
					HOME: fixture.root,
					BUNCARGO_PORT_OFFSET: "0",
					CI: "false",
					NO_COLOR: color ? "" : "1",
					FORCE_COLOR: color ? "1" : "",
					DOCKER_HOST: "unix:///nonexistent-buncargo-test.sock",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		let output = "";
		const reading = (async () => {
			const reader = child.stdout.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				output += Buffer.from(value).toString();
			}
		})();
		const errors = new Response(child.stderr).text();
		try {
			const deadline = Date.now() + 10000;
			if (failSeed) {
				const exit = await Promise.race([
					child.exited,
					Bun.sleep(10000).then(() => {
						throw new Error("Failed seed did not end the CLI");
					}),
				]);
				expect(exit).toBe(1);
				await expect(
					fetch(`http://localhost:${fixture.port}`),
				).rejects.toThrow();
				expect(await errors).toContain("Seeding failed with exit code 17");
			} else {
				while (
					!output.includes('"type":"buncargo.startup"') &&
					Date.now() < deadline
				)
					await Bun.sleep(20);
				expect(output).toContain('"type":"buncargo.startup"');
				expect(
					await Bun.file(join(fixture.root, "seed-finished")).exists(),
				).toBe(true);
				expect(stripVTControlCharacters(output)).toMatch(/seed\s+seed output/);
				// Stream mode writes the seed to the run's logs, as the TUI does.
				expect(await seedLog(fixture.root, deadline)).toContain("seed output");
				expect(
					(await Bun.file(join(fixture.root, "events")).text())
						.trim()
						.split("\n"),
				).toEqual(["seed begin", "app", "seed end"]);
				const report = JSON.parse(
					output
						.split("\n")
						.find((line) => line.startsWith('{"type":"buncargo.startup"')) ??
						"{}",
				);
				expect(
					report.phases.some(
						(phase: { name: string }) => phase.name === "seed",
					),
				).toBe(true);
				expect(
					report.phases.some(
						(phase: { name: string }) => phase.name === "app readiness",
					),
				).toBe(true);
			}
		} finally {
			child.kill("SIGINT");
			await child.exited;
			await reading;
			await errors;
			await fixture.cleanup();
		}
	},
	15000,
);

/** The run's `seed.log`, once its buffered write has landed. */
async function seedLog(root: string, deadline: number): Promise<string> {
	while (Date.now() < deadline) {
		const [dir] = listRunLogDirs(root);
		const file = dir ? Bun.file(join(dir, "seed.log")) : undefined;
		if (file && (await file.exists())) return file.text();
		await Bun.sleep(20);
	}
	return "";
}
