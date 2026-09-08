/** Disposable Docker contracts, run by the dedicated integration CI job. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment, defineDevConfig } from "../src";
import { observeStartupMetrics } from "../src/core/startup-metrics";

async function verifyContainerReuse(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "buncargo-docker-contract-"));
	const projectPrefix = `buncargo-ci-${process.pid}`;

	function environment(revision: string) {
		return createDevEnvironment(
			defineDevConfig({
				projectPrefix,
				services: {
					redis: {
						port: 6379,
						healthCheck: "redis-cli",
						docker: {
							image: "redis:7-alpine",
							environment: { CONTRACT_REVISION: revision },
						},
					},
				},
				apps: {
					cli: { port: 3000, devCommand: false, requiredServices: ["redis"] },
				},
				options: {
					worktreeIsolation: false,
					autoShutdown: false,
					verbose: false,
				},
			}),
			{ root, containerRuntime: "docker" },
		);
	}

	const first = environment("one");

	function containerId(): string {
		const result = Bun.spawnSync(
			[
				"docker",
				"ps",
				"-aq",
				"--filter",
				`label=com.docker.compose.project=${first.projectName}`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const ids = result.stdout.toString().trim().split("\n").filter(Boolean);
		assert.equal(
			ids.length,
			1,
			"Expected exactly the disposable selected service",
		);
		const id = ids[0];
		assert(id);
		return id;
	}

	const decisions: string[] = [];
	const stopObserving = observeStartupMetrics((name) => {
		if (name.startsWith("container ")) decisions.push(name);
	});

	try {
		await first.start({ startServers: false, verbose: false });
		const original = containerId();
		await first.start({ startServers: false, verbose: false });
		assert.equal(
			containerId(),
			original,
			"Warm start must reuse its container",
		);
		assert.deepEqual(
			decisions,
			["container reconcile", "container reuse"],
			"Warm start must skip the runtime up operation",
		);
		const changed = environment("two");
		await changed.start({ startServers: false, verbose: false });
		assert.notEqual(
			containerId(),
			original,
			"Changed Compose environment must reconcile",
		);
		console.log("Docker start/reuse/change contract passed");
	} finally {
		stopObserving();
		await first.stop({ verbose: false, removeVolumes: true });
		rmSync(root, { recursive: true, force: true });
	}
}

async function verifyPreparation(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "buncargo-monorepo-"));
	const prefix = `buncargo-monorepo-${process.pid}`;
	let bootstraps = 0;

	// Owning the table requires the role supplied by beforeMigrations.
	writeFileSync(
		join(root, "migrate.ts"),
		`import { SQL } from "bun";

	const sql = new SQL(process.env.DATABASE_URL!);
	await sql.unsafe("CREATE TABLE IF NOT EXISTS proof (id integer); ALTER TABLE proof OWNER TO fixture_role");
	await sql.close();`,
	);

	function config(fail = false) {
		return defineDevConfig({
			projectPrefix: prefix,
			services: {
				postgres: {
					port: 5432,
					healthCheck: "pg_isready",
					docker: {
						image: "postgres:16",
						environment: { POSTGRES_PASSWORD: "postgres" },
						volumes: ["dbdata:/var/lib/postgresql/data"],
					},
				},
				init: {
					kind: "job",
					rerun: "always",
					healthTimeout: 30000,
					docker: {
						image: "postgres:16",
						environment: { PGPASSWORD: "postgres" },
						command: [
							"sh",
							"-c",
							fail
								? "echo initializer-failure >&2; exit 7"
								: "psql -h postgres -U postgres -c 'SELECT 1'",
						],
						depends_on: { postgres: { condition: "service_healthy" } },
					},
				},
				delayed: {
					kind: "job",
					rerun: "always",
					afterPreparation: true,
					healthTimeout: 30000,
					docker: {
						image: "postgres:16",
						environment: { PGPASSWORD: "postgres" },
						command: [
							"sh",
							"-c",
							"psql -h postgres -U postgres -c 'SELECT * FROM proof'",
						],
						depends_on: {
							init: { condition: "service_completed_successfully" },
						},
					},
				},
			},
			apps: {
				api: {
					kind: "worker",
					devCommand: `${process.execPath} -e 'setInterval(()=>{},1000)'`,
					requiredServices: ["delayed"],
				},
			},
			migrations: [
				{
					name: "role-dependent",
					command: `${process.execPath} migrate.ts`,
					requiredServices: ["postgres"],
				},
			],
			hooks: {
				beforeMigrations: async (ctx) => {
					bootstraps++;
					assert.deepEqual(
						new Set(ctx.selectedServices),
						new Set(["delayed", "init", "postgres"]),
					);
					await ctx.exec([
						process.execPath,
						"-e",
						`import { SQL } from "bun";

	const sql = new SQL(process.env.DATABASE_URL);
	await sql.unsafe("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fixture_role') THEN CREATE ROLE fixture_role; END IF; END $$");
	await sql.close();`,
					]);
				},
			},
			options: { verbose: false, autoShutdown: false },
			docker: { volumes: { dbdata: {} } },
		});
	}

	const env = createDevEnvironment(config(), {
		root,
		containerRuntime: "docker",
	});

	try {
		await env.start({ startServers: false });
		assert.equal(bootstraps, 1);

		const fromExec = await env.exec([
			process.execPath,
			"-e",
			"process.stdout.write(process.env.DATABASE_URL ?? '')",
		]);
		assert.equal(fromExec.stdout, env.urls.postgres);

		// A warm restart must repeat explicitly authorized initialization.
		await env.start({ startServers: false });
		assert.equal(bootstraps, 2, "Bootstrap is never hash-cached");

		const failing = createDevEnvironment(config(true), {
			root,
			containerRuntime: "docker",
		});
		await assert.rejects(
			failing.start({ startServers: false }),
			/initializer-failure|exited.*7/,
		);
		assert.equal(bootstraps, 2, "Failed prerequisite must prevent bootstrap");

		// Reset volumes removes the role and table, so initialization must rebuild both.
		await env.stop({ removeVolumes: true, verbose: false });
		await env.start({ startServers: false });
		assert.equal(bootstraps, 3, "Reset volumes must run initialization again");
		console.log(
			"Disposable monorepo jobs/bootstrap/restart/reset/exec contract passed",
		);
	} finally {
		await env.stop({ removeVolumes: true, verbose: false });
		rmSync(root, { recursive: true, force: true });
	}
}

await verifyContainerReuse();
await verifyPreparation();
