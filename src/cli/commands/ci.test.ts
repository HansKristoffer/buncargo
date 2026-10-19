import { describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import type { RunEntry } from "../../core/run-registry";
import { startFakeInfisical } from "../../core/secrets/fake-infisical.testing";
import type { BuncargoContainer, BuncargoVolume } from "../../types";
import { ciLeftoverVolumes, parseCiArgs } from "./ci";
import { withAppendedArgs } from "./exec";

const cli = [process.execPath, resolve(import.meta.dir, "../bin.ts")];

describe("parseCiArgs", () => {
	it("splits options from the command at --", () => {
		const parsed = parseCiArgs([
			"--migrate",
			"--services=postgres, redis",
			"--",
			"bun",
			"test",
			"--bail",
		]);
		expect(parsed.migrate).toBe(true);
		expect(parsed.seed).toBe(false);
		expect(parsed.services).toEqual(["postgres", "redis"]);
		expect(parsed.command).toEqual(["bun", "test", "--bail"]);
		expect(parsed.errors).toEqual([]);
	});

	it("allows no command, for a migrations/seed-only check", () => {
		expect(parseCiArgs(["--seed"]).command).toEqual([]);
	});

	it("rejects unknown flags and stray arguments", () => {
		expect(parseCiArgs(["--nope", "bun"]).errors).toEqual([
			"Unknown flag: --nope",
			"Unexpected argument before --: bun",
		]);
	});
});

describe("withAppendedArgs", () => {
	it("keeps a bare command a shell string", () => {
		expect(withAppendedArgs("bun scripts/seed.ts", [])).toBe(
			"bun scripts/seed.ts",
		);
	});

	// Positional parameters: the shell never re-parses what was passed.
	it("passes extra args to sh as positional parameters", () => {
		expect(withAppendedArgs("bun seed.ts", ["a b", "$HOME"])).toEqual([
			"sh",
			"-c",
			'bun seed.ts "$@"',
			"sh",
			"a b",
			"$HOME",
		]);
	});
});

it("runs the command without fetching app or config-level secrets", async () => {
	const infisical = startFakeInfisical();
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {projectPrefix:'cisec',services:{},apps:{api:{port:3000,devCommand:false,secrets:{projectId:'api'}}},secrets:{projectId:'shared',siteUrl:${JSON.stringify(infisical.siteUrl)}}};`,
	);

	try {
		const result = await execAsync(
			[
				...cli,
				"ci",
				"--migrate",
				"--",
				process.execPath,
				"-e",
				"console.log('ran')",
			],
			root,
			{
				HOME: infisical.home,
				BUNCARGO_INFISICAL_PATH: infisical.cliPath,
			},
		);
		expect(result.stdout).toContain("ran");
		expect(infisical.requests).toEqual([]);
		expect(infisical.cliCalls()).toEqual([]);
	} finally {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * The stack comes down, volumes included, however the run ends. `docker`
 * is a fake that records its calls; the signals come from the fake or the
 * command itself, at the moment each case is about.
 */
describe("ci teardown", () => {
	const cases = [
		{
			name: "the command fails",
			command: ["sh", "-c", "exit 3"],
			exitCode: 3,
		},
		{
			name: "SIGINT arrives while the command runs",
			command: ["sh", "-c", "kill -INT $PPID; exec sleep 30"],
			exitCode: 130,
		},
		{
			name: "SIGTERM arrives while the command runs",
			command: ["sh", "-c", "kill -TERM $PPID; exec sleep 30"],
			exitCode: 143,
		},
		{
			name: "starting the containers fails",
			fake: { up: 'echo "pull denied" >&2; exit 1' },
			exitCode: 1,
		},
		{
			name: "SIGINT arrives while the containers start",
			fake: { up: "kill -INT $PPID" },
			exitCode: 130,
		},
		{
			name: "SIGINT arrives while the stack comes down",
			fake: { down: "kill -INT $PPID" },
			exitCode: 130,
		},
	];

	for (const { name, command = ["true"], fake = {}, exitCode } of cases) {
		it(`removes the stack when ${name}`, async () => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
			const log = join(root, "docker.log");
			const docker = join(root, "docker");
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ workspaces: [] }),
			);
			writeFileSync(
				join(root, "dev.config.ts"),
				"export default {projectPrefix:'citd',services:{postgres:{port:5432}},apps:{}};",
			);
			const on = (step: "up" | "down") =>
				`*" ${step}"*) ${fake[step as keyof typeof fake] ?? ":"}; echo "${step} finished" >> "${log}" ;;`;
			writeFileSync(
				docker,
				`#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n  ${on("up")}\n  ${on("down")}\nesac\n`,
				{ mode: 0o755 },
			);

			try {
				const result = await execAsync(
					[...cli, "ci", "--", ...command],
					root,
					{ HOME: join(root, "home"), BUNCARGO_CONTAINER_BINARY: docker },
					{ throwOnError: false },
				);
				expect(result.exitCode).toBe(exitCode);
				const calls = readFileSync(log, "utf-8");
				expect(calls).toMatch(/compose .* down -v\ndown finished\n$/);
				expect(result.stdout).toContain("Containers stopped");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});

it("says who removed the stack when the command fails without it", async () => {
	// The incident: tests failed on ECONNREFUSED, the teardown said "No
	// resource found to remove", and the cause was in another process's log.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
	const home = join(root, "home");
	const docker = join(root, "docker");
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "dev.config.ts"),
		"export default {projectPrefix:'cigone',services:{postgres:{port:5432}},apps:{}};",
	);
	// Lists nothing: the containers are gone by the time anyone looks.
	writeFileSync(docker, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// The command plays the sweep that removes the stack while it runs.
	const sweep = `require("node:fs").writeFileSync(${JSON.stringify(
		join(home, ".buncargo", "removals.json"),
	)}, JSON.stringify({ version: 1, removals: [{ at: new Date().toISOString(), projectName: process.env.COMPOSE_PROJECT_NAME, root: ${JSON.stringify(
		root,
	)}, runtime: "docker", reason: "owner gone for 16s", by: { command: "buncargo watchdog", pid: 4242, user: "ci", version: "12.4.0" } }] })); process.exit(3);`;

	try {
		const result = await execAsync(
			[...cli, "ci", "--", process.execPath, "-e", sweep],
			root,
			{ HOME: home, BUNCARGO_CONTAINER_BINARY: docker },
			{ throwOnError: false },
		);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain(
			"buncargo's watchdog (pid 4242, user ci, buncargo 12.4.0) removed cigone",
		);
		expect(result.stderr).toContain(": owner gone for 16s");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("claims its stack with an idle hold, so the sweep removes it after a SIGKILL", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
	const docker = join(root, "docker");
	const snapshot = join(root, "runs.snapshot.json");
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "dev.config.ts"),
		"export default {projectPrefix:'cihold',services:{postgres:{port:5432}},apps:{},options:{autoShutdown:false}};",
	);
	writeFileSync(docker, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

	try {
		const result = await execAsync(
			[
				...cli,
				"ci",
				"--",
				"cp",
				join(root, "home", ".buncargo", "runs.json"),
				snapshot,
			],
			root,
			{ HOME: join(root, "home"), BUNCARGO_CONTAINER_BINARY: docker },
			{ throwOnError: false },
		);
		expect(result.exitCode).toBe(0);
		const { runs } = JSON.parse(readFileSync(snapshot, "utf-8")) as {
			runs: { idleTimeoutMs?: number }[];
		};
		expect(runs.map((run) => run.idleTimeoutMs)).toEqual([3 * 60 * 1000]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("ciLeftoverVolumes", () => {
	const volume = (name: string, project: string): BuncargoVolume => ({
		name,
		project,
		runtime: "docker",
	});
	const container = (project: string): BuncargoContainer =>
		({ id: project, project, state: "running" }) as BuncargoContainer;
	const run = (projectName: string) => ({ projectName }) as RunEntry;

	it("takes the leftover volumes of a ci project nothing is using", () => {
		expect(
			ciLeftoverVolumes({
				projectName: "demo-ci",
				volumes: [
					volume("demo-ci_postgres_data", "demo-ci"),
					volume("demo_postgres_data", "demo"),
				],
				containers: [],
				runs: [],
			}),
		).toEqual(["demo-ci_postgres_data"]);
	});

	it("leaves them while a container of the project is up", () => {
		expect(
			ciLeftoverVolumes({
				projectName: "demo-ci",
				volumes: [volume("demo-ci_postgres_data", "demo-ci")],
				containers: [container("demo-ci")],
				runs: [],
			}),
		).toEqual([]);
	});

	it("leaves them while a run on record names the project", () => {
		expect(
			ciLeftoverVolumes({
				projectName: "demo-ci",
				volumes: [volume("demo-ci_postgres_data", "demo-ci")],
				containers: [],
				runs: [run("demo-ci")],
			}),
		).toEqual([]);
	});

	it("never takes an unattributed volume", () => {
		expect(
			ciLeftoverVolumes({
				projectName: "demo-ci",
				volumes: [{ name: "stray", runtime: "docker" }],
				containers: [],
				runs: [],
			}),
		).toEqual([]);
	});
});
