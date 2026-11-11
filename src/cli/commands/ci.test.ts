import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import { CI_ENV_VARS } from "../../core/runtime-flags";
import { startFakeInfisical } from "../../core/secrets/fake-infisical.testing";
import { parseCiArgs } from "./ci";
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

	it("rejects a --schema it does not know", () => {
		expect(parseCiArgs(["--schema=reset"]).errors).toHaveLength(1);
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
				expect(result.stderr).toContain("Containers stopped");
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

it("leaves stdout to the command, byte for byte", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
	const docker = join(root, "docker");
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "dev.config.ts"),
		"export default {projectPrefix:'cistdout',services:{postgres:{port:5432}},apps:{}};",
	);
	writeFileSync(docker, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

	try {
		const result = await execAsync(
			[...cli, "ci", "--", "printf", "ok 1\\nok 2\\n"],
			root,
			{ HOME: join(root, "home"), BUNCARGO_CONTAINER_BINARY: docker },
		);

		expect(result.stdout).toBe("ok 1\nok 2\n");
		expect(result.stderr).toContain("Containers stopped");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * A checkout with one Postgres service and a `docker` that records every call
 * as `<pid of its caller> <args>` and runs `onCall` (shell, with `$*` the args).
 */
function stubbedCheckout(prefix: string, onCall = "", extraConfig = "") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
	const log = join(root, "docker.log");
	const docker = join(root, "docker");
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {projectPrefix:'${prefix}',services:{postgres:{port:5432,healthCheck:false}},apps:{}${extraConfig}};`,
	);
	writeFileSync(
		docker,
		`#!/bin/sh\necho "$PPID $*" >> "${log}"\n${onCall}\nexit 0\n`,
		{ mode: 0o755 },
	);
	/** `unset` names variables the run must not inherit. */
	const run = async (
		args: string[],
		env: Record<string, string> = {},
		unset: readonly string[] = [],
	) => {
		const childEnv: Record<string, string | undefined> = {
			...process.env,
			HOME: join(root, "home"),
			BUNCARGO_CONTAINER_BINARY: docker,
			...env,
		};
		for (const name of unset) delete childEnv[name];
		const child = Bun.spawn([...cli, "ci", ...args], {
			cwd: root,
			env: childEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stderr };
	};
	return {
		root,
		run,
		calls: () => readFileSync(log, "utf-8").trim().split("\n"),
		[Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
	};
}

it("gives two runs in one checkout their own stacks", async () => {
	using checkout = stubbedCheckout("cipair");

	const results = await Promise.all([
		checkout.run(["--", "true"]),
		checkout.run(["--", "true"]),
	]);
	expect(results.map((result) => result.exitCode)).toEqual([0, 0]);

	// Each run's Compose calls, by the run that made them.
	const projects = new Map<string, Set<string>>();
	for (const line of checkout.calls()) {
		const [pid = "", ...args] = line.split(" ");
		const project = args[args.indexOf("-p") + 1];
		if (args[0] !== "compose" || !project) continue;
		projects.set(pid, (projects.get(pid) ?? new Set()).add(project));
	}
	const perRun = [...projects.values()].map((names) => [...names]);
	expect(perRun).toHaveLength(2);
	for (const names of perRun) {
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/^cipair-buncargo-ci-[^-]+-ci-[0-9a-f]{6}$/);
	}
	expect(perRun[0]).not.toEqual(perRun[1]);
});

it("runs its stack on tmpfs and leaves no compose file behind", async () => {
	using checkout = stubbedCheckout(
		"citmpfs",
		`case "$*" in *" up "*) cat ${"$"}(dirname "$0")/.buncargo/docker-compose.ci-*.generated.yml >> "$(dirname "$0")/up.yml" ;; esac`,
	);

	const result = await checkout.run(["--", "true"]);

	expect(result.exitCode).toBe(0);
	const model = readFileSync(join(checkout.root, "up.yml"), "utf-8");
	expect(model).toContain('tmpfs:\n      - "/var/lib/postgresql/data"');
	expect(model).not.toContain("postgres_data");
	expect(
		readdirSync(join(checkout.root, ".buncargo")).filter((name) =>
			name.startsWith("docker-compose.ci-"),
		),
	).toEqual([]);
});

it("names a self-hosted runner in the project", async () => {
	using checkout = stubbedCheckout("cirunner");

	await checkout.run(["--", "true"], {
		RUNNER_ENVIRONMENT: "self-hosted",
		RUNNER_NAME: "r1",
	});

	expect(checkout.calls().join("\n")).toMatch(/ -p \S+-ci-[0-9a-f]{6}-r1 /);
});

it("holds a check slot from before the services start until teardown", async () => {
	// Records the slot's holder each time the stack comes up or down.
	using checkout = stubbedCheckout(
		"cislot",
		`case "$*" in *" up "*|*" down "*) cat "$HOME/.buncargo/check-slots/0.lock" >> "$(dirname "$0")/holders"; echo >> "$(dirname "$0")/holders" ;; esac`,
	);
	const result = await checkout.run(
		["--slot", "--", "true"],
		{ BUNCARGO_CHECK_SLOTS: "1" },
		// A slot is skipped in CI, and this suite runs in CI too.
		CI_ENV_VARS,
	);

	expect(result.exitCode).toBe(0);
	const holders = readFileSync(join(checkout.root, "holders"), "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { label: string });
	expect(holders.map((holder) => holder.label)).toEqual(["ci true", "ci true"]);
	expect(
		existsSync(
			join(checkout.root, "home", ".buncargo", "check-slots", "0.lock"),
		),
	).toBe(false);
});

it("pushes the Prisma schema instead of migrating with --schema=push", async () => {
	using checkout = stubbedCheckout("cipush", "", ",prisma:{}");
	const bin = join(checkout.root, "packages/prisma/node_modules/.bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "prisma"),
		`#!/bin/sh\necho "$*" >> "${checkout.root}/prisma.log"\n`,
		{ mode: 0o755 },
	);

	const result = await checkout.run(["--schema=push", "--migrate"]);

	expect(result.exitCode).toBe(0);
	expect(readFileSync(join(checkout.root, "prisma.log"), "utf-8")).toBe(
		"db push\n",
	);
});
