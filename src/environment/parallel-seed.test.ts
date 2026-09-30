import { expect, it } from "bun:test";
import { join } from "node:path";
import { createDevEnvironment } from "./create-dev-environment";
import { parallelSeedFixture } from "./parallel-seed.testing";

for (const beforeApps of [undefined, false] as const) {
	it(`library seed/app ordering with beforeApps=${beforeApps}`, async () => {
		const fixture = await parallelSeedFixture({ beforeApps });
		const offset = process.env.BUNCARGO_PORT_OFFSET;
		process.env.BUNCARGO_PORT_OFFSET = "0";
		const env = createDevEnvironment(fixture.config, { root: fixture.root });
		const ready: boolean[] = [];
		try {
			await env.start({
				productionBuild: false,
				verbose: false,
				watchdog: false,
			});
			ready.push(await Bun.file(join(fixture.root, "seed-finished")).exists());
			const events = (await Bun.file(join(fixture.root, "events")).text())
				.trim()
				.split("\n");
			expect(events).toEqual(
				beforeApps === false
					? ["seed begin", "app", "seed end"]
					: ["seed begin", "seed end", "app"],
			);
			expect(ready).toEqual([true]);
			expect((await fetch(`http://localhost:${fixture.port}`)).ok).toBe(true);
		} finally {
			await env.stop({ verbose: false });
			if (offset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
			else process.env.BUNCARGO_PORT_OFFSET = offset;
			await fixture.cleanup();
		}
	}, 15000);
}

for (const failure of ["seed", "app"] as const) {
	it(`cleans up both sides of a concurrent library ${failure} failure`, async () => {
		const fixture = await parallelSeedFixture({
			beforeApps: false,
			failSeed: failure === "seed",
			failApp: failure === "app",
		});
		const offset = process.env.BUNCARGO_PORT_OFFSET;
		process.env.BUNCARGO_PORT_OFFSET = "0";
		const env = createDevEnvironment(fixture.config, { root: fixture.root });
		try {
			await expect(
				env.start({ productionBuild: false, verbose: false, watchdog: false }),
			).rejects.toThrow(
				failure === "seed"
					? "Seeding failed with exit code 17"
					: 'App "web" exited',
			);
			await expect(fetch(`http://localhost:${fixture.port}`)).rejects.toThrow();
			const seedPid = Number(
				await Bun.file(join(fixture.root, "seed-started")).text(),
			);
			expect(() => process.kill(seedPid, 0)).toThrow();
		} finally {
			await env.stop({ verbose: false });
			if (offset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
			else process.env.BUNCARGO_PORT_OFFSET = offset;
			await fixture.cleanup();
		}
	}, 15000);
}
