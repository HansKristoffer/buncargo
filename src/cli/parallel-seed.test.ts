import { expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { parallelSeedFixture } from "../environment/parallel-seed.testing";

for (const failSeed of [false, true]) {
	it(`CLI overlaps seed and apps and joins readiness (failed seed=${failSeed})`, async () => {
		const fixture = await parallelSeedFixture({ beforeApps: false, failSeed });
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
				expect(output).toMatch(/seed\s+seed output/);
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
	}, 15000);
}
