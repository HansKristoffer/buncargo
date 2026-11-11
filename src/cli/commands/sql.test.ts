import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import { loadDevEnv } from "../../loader";
import { CliError } from "../errors";
import {
	extractScriptFiles,
	psqlHasOwnInput,
	runSql,
	type SqlDeps,
	scratchCommand,
	scratchUrl,
	sqlClientCommand,
} from "./sql";

const cli = resolve(import.meta.dir, "../bin.ts");
const credentials = { user: "app", password: "secret", database: "appdb" };
const psql = ["env", "PGPASSWORD=secret", "psql", "-X", "-U", "app", "-d"];

describe("sqlClientCommand", () => {
	it("opens psql with the service's own credentials", () => {
		expect(sqlClientCommand("postgres", credentials, {}).command).toEqual([
			...psql,
			"appdb",
		]);
	});

	it("wraps a single SELECT as one JSON array of rows", () => {
		const invocation = sqlClientCommand("postgres", credentials, {
			input: { kind: "query", text: "select id from users;" },
			json: true,
		});
		expect(invocation.jsonWrapped).toBe(true);
		expect(invocation.command).toContain("-A");
		expect(invocation.command).toContain("ON_ERROR_STOP=1");
		expect(invocation.command.at(-1)).toBe(
			"select coalesce(json_agg(_buncargo_rows.*), '[]'::json) from (\nselect id from users\n) _buncargo_rows",
		);
	});

	it("runs an UPDATE or several statements plain under --json, and says why", () => {
		const update = sqlClientCommand("postgres", credentials, {
			input: { kind: "query", text: "update users set name = 'x'" },
			json: true,
		});
		expect(update.jsonWrapped).toBe(false);
		expect(update.command.slice(-2)).toEqual([
			"-c",
			"update users set name = 'x'",
		]);
		expect(update.command).not.toContain("-A");
		expect(update.plainReason).toContain("not a SELECT or WITH");

		const two = sqlClientCommand("postgres", credentials, {
			input: { kind: "query", text: "select 1; select 2" },
			json: true,
		});
		expect(two.command.at(-1)).toBe("select 1; select 2");
		expect(two.plainReason).toContain("more than one statement");
	});

	it("feeds a script on stdin and passes client arguments through", () => {
		const bytes = new TextEncoder().encode("\\timing on\nselect 1;");
		expect(
			sqlClientCommand("postgres", credentials, {
				input: { kind: "script", bytes },
				database: "scratch_perf",
				clientArgs: ["-tA"],
			}),
		).toEqual({
			command: [
				...psql,
				"scratch_perf",
				"-v",
				"ON_ERROR_STOP=1",
				"-tA",
				"-f",
				"-",
			],
			stdin: bytes,
			jsonWrapped: false,
			plainReason: undefined,
		});
	});

	it("splits a redis command into words and refuses --json there", () => {
		expect(
			sqlClientCommand("redis", undefined, {
				input: { kind: "query", text: 'SET k "a b"' },
			}).command,
		).toEqual(["redis-cli", "SET", "k", "a b"]);
		expect(() =>
			sqlClientCommand("redis", undefined, {
				input: { kind: "query", text: "GET k" },
				json: true,
			}),
		).toThrow("not supported");
	});

	it("needs SQL for --json, and a preset it knows", () => {
		expect(() =>
			sqlClientCommand("postgres", credentials, { json: true }),
		).toThrow("--json needs SQL");
		expect(() => sqlClientCommand("mailpit", undefined, {})).toThrow(
			"no client for mailpit",
		);
	});
});

describe("extractScriptFiles", () => {
	it("takes psql's file arguments out, in every spelling", () => {
		expect(
			extractScriptFiles([
				"-tA",
				"-f",
				"a.sql",
				"--file=b.sql",
				"-fc.sql",
				"--file",
				"-",
				"-v",
				"x=1",
			]),
		).toEqual({
			files: ["a.sql", "b.sql", "c.sql", "-"],
			rest: ["-tA", "-v", "x=1"],
		});
	});
});

describe("psqlHasOwnInput", () => {
	it("finds psql's own work in grouped and long options, not in values", () => {
		for (const args of [
			["-c", "select 1"],
			["-tAc", "select 1"],
			["-lqt"],
			["--list"],
			["-V"],
			["--command=select 1"],
		])
			expect(psqlHasOwnInput(args)).toBe(true);
		for (const args of [
			["-tA"],
			["-vclear=1"],
			["-v", "ON_ERROR_STOP=0"],
			["-dlocal"],
		])
			expect(psqlHasOwnInput(args)).toBe(false);
	});
});

describe("scratch databases", () => {
	it("recreates scratch_<name> in two statements, outside a transaction", () => {
		const argv = scratchCommand(credentials, "migcheck", "create");
		expect(argv.slice(-4)).toEqual([
			"-c",
			"drop database if exists scratch_migcheck with (force)",
			"-c",
			"create database scratch_migcheck",
		]);
		expect(argv).toContain("postgres");
		expect(scratchCommand(credentials, "migcheck", "drop").at(-1)).toBe(
			"drop database if exists scratch_migcheck with (force)",
		);
	});

	it("only takes names that cannot reach another database", () => {
		for (const name of ["app; drop", "App", "", "1x"])
			expect(() => scratchCommand(credentials, name, "drop")).toThrow(
				"Scratch database names",
			);
	});

	it("prints a URL the host can connect to", () => {
		expect(scratchUrl(credentials, 13432, "migcheck")).toBe(
			"postgresql://app:secret@localhost:13432/scratch_migcheck",
		);
	});
});

describe("runSql", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function fixture(services = "{postgres:{port:5432,database:'app'}}"): string {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-sql-")));
		roots.push(root);
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(
			join(root, "dev.config.ts"),
			`export default {projectPrefix:'sqlcli',services:${services}};`,
		);
		return root;
	}

	interface Recorded {
		loads: boolean[];
		started: string[];
		spawned: { argv: string[]; stdin?: string; stdout: string }[];
		stdinReads: number;
		printed: string[];
		warned: string[];
	}

	/** A checkout whose Postgres is running unless `down`, with stdin `piped`. */
	function harness(options: {
		down?: boolean;
		piped?: string;
		files?: Record<string, string>;
		stderr?: string;
		exitCode?: number;
		services?: string;
	}) {
		const root = fixture(options.services);
		let running = !options.down;
		const recorded: Recorded = {
			loads: [],
			started: [],
			spawned: [],
			printed: [],
			stdinReads: 0,
			warned: [],
		};
		const deps: SqlDeps = {
			loadEnv: async (readOnly) => {
				recorded.loads.push(readOnly);
				return loadDevEnv({ cwd: root, readOnly: true });
			},
			execArgv: async (_env, request) =>
				running ? ["exec", request.serviceName, ...request.command] : undefined,
			startService: async (_env, serviceName) => {
				recorded.started.push(serviceName);
				running = true;
			},
			stdinIsTerminal: () => options.piped === undefined,
			readStdin: async () => {
				recorded.stdinReads++;
				return new TextEncoder().encode(options.piped);
			},
			readFile: async (path) => {
				const text = options.files?.[path];
				if (text === undefined) throw new Error(`ENOENT: ${path}`);
				return new TextEncoder().encode(text);
			},
			isInteractive: () => false,
			spawn: async (argv, io) => {
				recorded.spawned.push({
					argv,
					stdin: io.stdin && new TextDecoder().decode(io.stdin),
					stdout: io.stdout,
				});
				if (options.stderr) io.onStderr?.(options.stderr);
				return options.exitCode ?? 0;
			},
			print: (line) => recorded.printed.push(line),
			warn: (line) => recorded.warned.push(line),
		};
		return { root, deps, recorded };
	}

	async function port(root: string): Promise<number> {
		const env = await loadDevEnv({ cwd: root, readOnly: true });
		return (env.ports as Record<string, number>).postgres as number;
	}

	it("starts only the database for --create-scratch when it is down, then prints the URL", async () => {
		const { root, deps, recorded } = harness({ down: true });

		expect(await runSql(["--create-scratch=perf"], deps)).toBe(0);

		expect(recorded.loads).toEqual([true, false]);
		expect(recorded.started).toEqual(["postgres"]);
		expect(recorded.spawned[0]?.argv.at(-1)).toBe(
			"create database scratch_perf",
		);
		expect(recorded.spawned[0]?.stdout).toBe("ignore");
		expect(recorded.printed).toEqual([
			`postgresql://postgres:postgres@localhost:${await port(root)}/scratch_perf`,
		]);
	});

	it("tells a stopped database how to start it, without --detach", async () => {
		const { deps, recorded } = harness({ down: true });

		const failure = await runSql(["-c", "select 1"], deps).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(CliError);
		const { message, hints } = failure as CliError;
		expect(message).toStartWith("postgres is not running for sqlcli");
		expect(hints[0]).toContain("buncargo dev --up-only");
		expect(hints[0]).toContain("no --detach");
		expect(hints[1]).toContain("buncargo sql --create-scratch=<name>");
		expect(recorded.started).toEqual([]);
	});

	it("runs against an existing database with --db, and prints its URL with --url", async () => {
		const { root, deps, recorded } = harness({});

		expect(await runSql(["--db=scratch_perf", "-c", "select 1"], deps)).toBe(0);
		const argv = recorded.spawned[0]?.argv ?? [];
		expect(argv.slice(argv.indexOf("-d"), argv.indexOf("-d") + 2)).toEqual([
			"-d",
			"scratch_perf",
		]);
		expect(argv.join(" ")).not.toContain("drop database");

		expect(await runSql(["--db=scratch_perf", "--url"], deps)).toBe(0);
		expect(await runSql(["--url"], deps)).toBe(0);
		const base = `postgresql://postgres:postgres@localhost:${await port(root)}`;
		expect(recorded.printed).toEqual([`${base}/scratch_perf`, `${base}/app`]);
		expect(recorded.spawned).toHaveLength(1);
	});

	it("runs piped SQL as a script, leaving stdin to psql unread", async () => {
		const { deps, recorded } = harness({ piped: "\\timing on\nselect 1;\n" });

		expect(await runSql([], deps)).toBe(0);

		const [spawned] = recorded.spawned;
		expect(spawned?.stdin).toBeUndefined();
		expect(recorded.stdinReads).toBe(0);
		expect(spawned?.argv.slice(-4)).toEqual([
			"-v",
			"ON_ERROR_STOP=1",
			"-f",
			"-",
		]);
	});

	it("reads piped SQL only when --json must look at it", async () => {
		const { deps, recorded } = harness({ piped: "select 1 as n\n" });

		expect(await runSql(["--json"], deps)).toBe(0);

		expect(recorded.stdinReads).toBe(1);
		expect(recorded.spawned[0]?.argv.at(-1)).toContain(
			"json_agg(_buncargo_rows.*)",
		);
	});

	it("leaves stdin alone when psql or another client has its own work", async () => {
		const { deps, recorded } = harness({ piped: "" });

		expect(await runSql(["--", "-lqt"], deps)).toBe(0);
		expect(recorded.spawned[0]?.argv).not.toContain("-f");
		expect(recorded.stdinReads).toBe(0);
	});

	it("passes arguments after -- to psql and reads -f files on the host", async () => {
		// Never created: the file is read through the injected reader.
		const file = join(tmpdir(), "buncargo-sql-query.sql");
		const { deps, recorded } = harness({ files: { [file]: "select 2;" } });

		expect(
			await runSql(["-c", "select 1", "--", "-tA", "-v", "x=1"], deps),
		).toBe(0);
		expect(recorded.spawned[0]?.argv.slice(-6)).toEqual([
			"ON_ERROR_STOP=1",
			"-tA",
			"-v",
			"x=1",
			"-c",
			"select 1",
		]);

		expect(await runSql(["--", "-tA", "-f", file], deps)).toBe(0);
		const spawned = recorded.spawned[1];
		expect(spawned?.stdin).toBe("select 2;");
		expect(spawned?.argv.slice(-3)).toEqual(["-tA", "-f", "-"]);
		expect(spawned?.argv).not.toContain(file);
	});

	it("names a -f file it cannot read", async () => {
		const { deps } = harness({});

		await expect(
			runSql(["--", "-f", "/nonexistent/q.sql"], deps),
		).rejects.toThrow("Could not read /nonexistent/q.sql");
	});

	it("runs an UPDATE and two statements plain under --json", async () => {
		const { deps, recorded } = harness({});

		expect(
			await runSql(["-c", "update users set name = 'x'", "--json"], deps),
		).toBe(0);
		expect(await runSql(["-c", "select 1; select 2", "--json"], deps)).toBe(0);

		expect(recorded.spawned.map(({ argv }) => argv.at(-1))).toEqual([
			"update users set name = 'x'",
			"select 1; select 2",
		]);
		expect(recorded.warned).toHaveLength(2);
		expect(recorded.warned[0]).toContain("ran as plain SQL");
	});

	it("shows errors of a wrapped query in the user's own lines", async () => {
		const { deps, recorded } = harness({
			stderr:
				'ERROR:  column "nope" does not exist\nLINE 2: select nope from users\n               ^\n',
			exitCode: 1,
		});

		expect(await runSql(["-c", "select nope from users", "--json"], deps)).toBe(
			1,
		);

		expect(recorded.warned).toEqual([
			'ERROR:  column "nope" does not exist\nLINE 1: select nope from users\n               ^',
		]);
		expect(recorded.warned.join("")).not.toContain("json_agg");
	});

	it("takes the Postgres service for Postgres-only flags when ClickHouse comes first", async () => {
		const { deps, recorded } = harness({
			services:
				"{clickhouse:{port:8123,secondaryPort:9000},postgres:{port:5432,database:'app'}}",
		});

		expect(await runSql(["--db=app", "-c", "select 1"], deps)).toBe(0);
		expect(await runSql(["-c", "select 1"], deps)).toBe(0);

		const [postgresOnly, unnamed] = recorded.spawned.map(({ argv }) => argv);
		expect(postgresOnly?.slice(0, 2)).toEqual(["exec", "postgres"]);
		expect(unnamed?.slice(0, 2)).toEqual(["exec", "clickhouse"]);
	});

	it("leaves stdout to the client, byte for byte", async () => {
		const root = fixture();
		const docker = join(root, "docker");
		// `ps` finds the container; `exec` is the client printing its rows.
		writeFileSync(
			docker,
			"#!/bin/sh\ncase \"$1\" in\n  ps) echo f00 ;;\n  exec) printf ' ?column? \\n----------\\n        1\\n' ;;\nesac\n",
			{ mode: 0o755 },
		);

		const result = await execAsync(
			[process.execPath, cli, "sql", "-c", "select 1"],
			root,
			{ BUNCARGO_CONTAINER_BINARY: docker },
		);

		expect(result.stdout).toBe(" ?column? \n----------\n        1\n");
	});
});
