import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunEntry } from "../../core/run-registry";
import { CI_ENV_VARS } from "../../core/runtime-flags";
import { formatEnvDotValue, formatEnvExports, getEnvDotPath } from "./runtime";

describe("getEnvDotPath", () => {
	const snapshot = {
		ports: { api: 3000, web: 3001 },
		urls: { api: "http://localhost:3000" },
		isWorktree: true,
	};

	it("reads nested values", () => {
		expect(getEnvDotPath(snapshot, "ports.api")).toBe(3000);
		expect(getEnvDotPath(snapshot, "urls.api")).toBe("http://localhost:3000");
		expect(getEnvDotPath(snapshot, "isWorktree")).toBe(true);
	});

	it("returns undefined for missing paths", () => {
		expect(getEnvDotPath(snapshot, "ports.missing")).toBeUndefined();
		expect(getEnvDotPath(snapshot, "ports.api.nested")).toBeUndefined();
	});
});

describe("formatEnvDotValue", () => {
	it("prints scalars raw and objects as JSON", () => {
		expect(formatEnvDotValue(3000)).toBe("3000");
		expect(formatEnvDotValue("http://localhost:3000")).toBe(
			"http://localhost:3000",
		);
		expect(formatEnvDotValue({ api: 3000 })).toBe('{"api":3000}');
	});
});

describe("formatEnvExports", () => {
	it("quotes values so a shell expands nothing", () => {
		expect(
			formatEnvExports({ DATABASE_URL: "postgres://a$b@x/db", NOTE: "it's" }),
		).toBe("export DATABASE_URL='postgres://a$b@x/db'\nexport NOTE='it'\\''s'");
	});
});

describe("buncargo prisma", () => {
	const cli = [process.execPath, resolve(import.meta.dir, "../bin.ts")];
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	/**
	 * A checkout whose `docker` answers everything and whose Prisma CLI is a
	 * script: it prints a migration to stdout, and records what it saw while
	 * it ran (the variables, the run registry) for the test to read.
	 */
	function checkout(prismaConfig = "{}") {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-prisma-")));
		roots.push(root);
		const bin = join(root, "packages/prisma/node_modules/.bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ workspaces: [] }),
		);
		writeFileSync(
			join(root, "dev.config.ts"),
			`export default {projectPrefix:'prismacli',services:{postgres:{port:5432,healthCheck:false}},apps:{},prisma:${prismaConfig},unsetEnv:['CLAUDECODE']};`,
		);
		// One container for the service, so Prisma's scratch database is "created".
		writeFileSync(
			join(root, "docker"),
			`#!/bin/sh\ncase "$*" in\n  "ps "*"{{.ID}}") echo c0ffee ;;\nesac\nexit 0\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "prisma"),
			`#!/bin/sh\nprintf '%s' "$CLAUDECODE" > "${root}/claudecode"\nprintf '%s' "$DATABASE_URL_DIRECT" > "${root}/direct-url"\ncp "$HOME/.buncargo/runs.json" "${root}/runs.during.json"\nprintf 'CREATE TABLE "user" ();\\n'\nexit "\${STUB_PRISMA_EXIT:-0}"\n`,
			{ mode: 0o755 },
		);
		return root;
	}

	/** The CLI as an agent runs it: no terminal, not CI. */
	async function prisma(
		root: string,
		args: string[],
		extraEnv: Record<string, string> = {},
	) {
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: join(root, "home"),
			BUNCARGO_CONTAINER_BINARY: join(root, "docker"),
			CLAUDECODE: "1",
		};
		for (const name of CI_ENV_VARS) delete env[name];
		Object.assign(env, extraEnv);
		const child = Bun.spawn([...cli, "prisma", ...args], {
			cwd: root,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	const readRuns = (path: string) =>
		(JSON.parse(readFileSync(path, "utf-8")) as { runs: RunEntry[] }).runs;

	it("claims the database while Prisma runs and releases it after", async () => {
		const root = checkout();

		const result = await prisma(root, ["studio"]);

		expect(result.exitCode).toBe(0);
		const [during] = readRuns(join(root, "runs.during.json"));
		expect(during?.services?.map((service) => service.name)).toEqual([
			"postgres",
		]);
		expect(during?.releasedAt).toBeUndefined();
		const [after] = readRuns(join(root, "home/.buncargo/runs.json"));
		expect(after?.sessionId).toBe(during?.sessionId);
		expect(after?.releasedAt).toBeDefined();
	});

	it("leaves stdout to Prisma, byte for byte", async () => {
		const result = await prisma(checkout(), ["migrate", "diff", "--script"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('CREATE TABLE "user" ();\n');
	});

	it("keeps the variables Prisma's agent guard reads, despite unsetEnv", async () => {
		const root = checkout();

		await prisma(root, ["migrate", "status"]);

		expect(readFileSync(join(root, "claudecode"), "utf-8")).toBe("1");
	});

	it("refuses migrate reset without a terminal unless --yes", async () => {
		const root = checkout();

		const refused = await prisma(root, ["migrate", "reset"]);
		expect(refused.exitCode).not.toBe(0);
		expect(refused.stderr).toContain("Refusing without a terminal");
		expect(existsSync(join(root, "runs.during.json"))).toBe(false);

		const confirmed = await prisma(root, ["migrate", "reset", "--yes"]);
		expect(confirmed.exitCode).toBe(0);
		expect(existsSync(join(root, "runs.during.json"))).toBe(true);
	});

	// A CI database is disposable, and its pipelines pass no --yes.
	it("runs migrate reset in CI without --yes", async () => {
		const root = checkout();

		const result = await prisma(root, ["migrate", "reset"], { CI: "true" });

		expect(result.exitCode).toBe(0);
		expect(existsSync(join(root, "runs.during.json"))).toBe(true);
	});

	it("writes a migration without a terminal, after the newest one, and prints its path", async () => {
		const root = checkout();
		// A folder from a clock ahead of this one: the new one still applies last.
		const migrations = join(root, "packages/prisma/prisma/migrations");
		mkdirSync(join(migrations, "20990101000000_init"), { recursive: true });
		writeFileSync(join(migrations, "20990101000000_init/migration.sql"), "");

		// `migrate diff --exit-code` exits 2 when the schema has changes.
		const result = await prisma(root, ["migration", "new", "add_x"], {
			STUB_PRISMA_EXIT: "2",
		});

		expect(result.exitCode).toBe(0);
		const folder = join(migrations, "20990101000001_add_x");
		expect(result.stdout).toBe(`${folder}\n`);
		expect(readFileSync(join(folder, "migration.sql"), "utf-8")).toBe(
			'CREATE TABLE "user" ();\n',
		);
	});

	it("writes nothing when the schema has no changes", async () => {
		const root = checkout();

		const result = await prisma(root, ["migration", "new", "add_x"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no migration was written");
		expect(existsSync(join(root, "packages/prisma/prisma/migrations"))).toBe(
			false,
		);
	});

	it("warns about an inherited URL to another server, without its credentials, and refuses a destructive command", async () => {
		const root = checkout();
		const direct = {
			DATABASE_URL_DIRECT:
				"postgresql://admin:hunter2@db.example.com:6543/prod",
		};

		const warned = await prisma(root, ["migrate", "status"], direct);
		expect(warned.exitCode).toBe(0);
		expect(warned.stderr).toContain(
			"DATABASE_URL_DIRECT points at db.example.com:6543",
		);
		expect(warned.stderr).not.toContain("hunter2");

		rmSync(join(root, "runs.during.json"));
		const refused = await prisma(root, ["migrate", "reset", "--yes"], direct);
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr).toContain("Refusing while DATABASE_URL_DIRECT");
		expect(refused.stderr).not.toContain("hunter2");
		expect(existsSync(join(root, "runs.during.json"))).toBe(false);
	});

	it("points every prisma.urlEnvVar name at the checkout's database", async () => {
		const root = checkout('{urlEnvVar:["DATABASE_URL","DATABASE_URL_DIRECT"]}');

		const result = await prisma(root, ["migrate", "status"], {
			DATABASE_URL_DIRECT:
				"postgresql://admin:hunter2@db.example.com:6543/prod",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("points at");
		expect(readFileSync(join(root, "direct-url"), "utf-8")).toMatch(
			/^postgres(ql)?:\/\/[^@]*@localhost:\d+\//,
		);
	});

	describe("migration check", () => {
		function git(root: string, ...args: string[]) {
			const result = Bun.spawnSync(["git", ...args], {
				cwd: root,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		}
		function migration(root: string, folder: string) {
			const dir = join(root, "packages/prisma/prisma/migrations", folder);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "migration.sql"), "");
		}
		/** main has two migrations; the branch adds `folder`. */
		function branchAdding(folder: string) {
			const root = checkout();
			git(root, "init", "-q", "-b", "main");
			migration(root, "20250101000000_init");
			migration(root, "20250301000000_orders");
			git(root, "add", "-A");
			git(root, "commit", "-qm", "base");
			git(root, "switch", "-qc", "feature");
			migration(root, folder);
			return root;
		}

		it("fails on a migration sorting before the newest on the base branch", async () => {
			const root = branchAdding("20250201000000_users");

			const result = await prisma(root, ["migration", "check"]);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				"20250201000000_users sorts before 20250301000000_orders, the newest migration on main",
			);
		});

		it("passes a migration after the newest on the base branch", async () => {
			const root = branchAdding("20250401000000_users");

			const result = await prisma(root, ["migration", "check", "--base=main"]);

			expect(result.exitCode).toBe(0);
		});
	});
});
