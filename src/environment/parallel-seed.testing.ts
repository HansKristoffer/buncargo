import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../core/shell-quote";

export async function parallelSeedFixture(
	options: { beforeApps?: boolean; failSeed?: boolean; failApp?: boolean } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "buncargo-parallel-seed-"));
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = Number(probe.port);
	probe.stop(true);
	await Bun.write(
		join(root, "package.json"),
		'{"name":"parallel-seed-fixture","private":true}',
	);
	await Bun.write(
		join(root, "app.ts"),
		`
import {appendFileSync} from "node:fs";
appendFileSync("events", "app\\n");
await Bun.write("app-started", String(process.pid));
${options.failApp ? "process.exit(7);" : 'Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("ok")});'}
`,
	);
	await Bun.write(
		join(root, "seed.ts"),
		`
import {appendFileSync} from "node:fs";
appendFileSync("events", "seed begin\\n");
await Bun.write("seed-started", String(process.pid));
console.log("seed output");
${options.beforeApps === false ? 'while (!(await Bun.file("app-started").exists())) await Bun.sleep(10);' : ""}
${options.failApp ? "await new Promise(() => {});" : "await Bun.sleep(100);"}
${options.failSeed ? "process.exit(17);" : 'appendFileSync("events", "seed end\\n"); await Bun.write("seed-finished", "yes");'}
`,
	);
	const config = {
		projectPrefix: "parallel-seed",
		services: {},
		apps: {
			web: {
				port,
				devCommand: `${shellQuote(process.execPath)} app.ts`,
				requiredServices: [],
				healthEndpoint: "/",
			},
		},
		seed: {
			command: `${shellQuote(process.execPath)} seed.ts`,
			requiredServices: [],
			...(options.beforeApps === undefined
				? {}
				: { beforeApps: options.beforeApps }),
		},
		options: { hosts: false, worktreeIsolation: false, verbose: false },
	};
	await Bun.write(
		join(root, "dev.config.ts"),
		`export default ${JSON.stringify(config)};`,
	);
	return {
		root,
		port,
		config,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
