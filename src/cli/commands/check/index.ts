import { existsSync } from "node:fs";
import { join } from "node:path";
import { chunkArray, getErrorMessage, startTimer, typedSwitch } from "hanzio";
import { childProcessEnv } from "../../../core/child-env";
import { buncargoCli } from "../../../core/cli-entry";
import { findMonorepoRoot } from "../../../core/ports";
import { changedFilesSince } from "../../../typecheck/changed";
import { loadCheckConfig } from "../../../typecheck/config-settings";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../../command-spec";
import { argumentsError, CliError } from "../../errors";
import {
	docPathsConfig,
	findDocProblems,
	formatDocProblem,
	markdownFiles,
} from "./docs";
import {
	type CheckMode,
	FILE_CHUNK,
	formatCommands,
	selectGates,
	testsFor,
	touches,
} from "./plan";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	staged: {
		name: "--staged",
		kind: "boolean",
		description: "Staged files only: no writes, no tests (pre-commit)",
	},
	all: {
		name: "--all",
		kind: "boolean",
		description: "Every file, workspace and gate; no tests (lint)",
	},
	base: {
		name: "--base",
		kind: "string",
		valueHint: "=<ref>",
		description:
			"Compare with the merge base of <ref> (default: origin's default branch)",
	},
} as const satisfies Record<string, FlagSpec>;

export const CHECK_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo check [docs] [--staged | --all] [--base=<ref>]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "docs",
			description:
				"Only check Markdown links and documented commands, in every doc",
		},
	],
	examples: [
		{
			command: "buncargo check",
			description:
				"Biome, typecheck, gates and nearby tests for this branch's changes",
		},
		{
			command: "buncargo check --staged",
			description: "The pre-commit hook: staged files, no writes",
		},
		{
			command: "buncargo check --all",
			description: "Every check but the tests, e.g. as `bun run lint`",
		},
	],
};

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];
const OUTPUT_TAIL_LINES = 80;

export interface Step {
	name: string;
	command: string[];
	cwd?: string;
}

/** A step that failed: what the digest at the end of `check` names. */
export interface StepFailure {
	name: string;
	/** The exit code, or why the command could not start (`E2BIG: …`). */
	reason: string;
	/** How to run it again by hand, from the repository root. */
	rerun: string;
}

/** Past this a rerun command shows its first arguments and a count. */
const RERUN_MAX_CHARS = 160;

function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg)
		? arg
		: `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The command to rerun one step, cut short when it lists many files. */
export function rerunCommand(step: Step): string {
	const prefix = step.cwd ? `cd ${shellQuote(step.cwd)} && ` : "";
	const words = step.command.map(shellQuote);
	let shown = prefix;
	for (const [index, word] of words.entries()) {
		const next = shown === prefix ? `${shown}${word}` : `${shown} ${word}`;
		if (next.length > RERUN_MAX_CHARS) {
			const rest = words.length - index;
			return `${shown} … (${rest} more arguments)`;
		}
		shown = next;
	}
	return shown;
}

/**
 * The last lines `check` prints when a step failed: each failure with its
 * exit code and the command to rerun it, so `buncargo check | tail` has the
 * whole verdict.
 */
export function formatFailureDigest(
	failures: readonly StepFailure[],
): string[] {
	if (failures.length === 0) return ["PASS"];
	return [
		`FAIL: ${failures.map((failure) => failure.name).join(", ")}`,
		...failures.map(
			(failure) =>
				`  ✗ ${failure.name} (${failure.reason}) · rerun: ${failure.rerun}`,
		),
	];
}

/**
 * Runs steps one at a time: one line per step, the tail of a failing step's
 * output, and the failures for the digest. A step passes on exit code 0 and
 * nothing else: a command that cannot even start (`E2BIG`, not installed)
 * fails, and so does one killed by a signal.
 */
export function stepRunner(root: string, print: (line: string) => void) {
	const failures: StepFailure[] = [];
	const finish = (
		name: string,
		elapsed: () => number,
		failure: Omit<StepFailure, "name"> | undefined,
	) => {
		const seconds = (elapsed() / 1000).toFixed(1);
		if (!failure) {
			print(`✓ ${name} ${seconds}s`);
			return;
		}
		print(`✗ ${name} ${seconds}s (${failure.reason})`);
		failures.push({ name, ...failure });
	};
	return {
		failures,
		/** Resolves to the step's exit code; a command that could not start is 127. */
		async run(step: Step): Promise<number> {
			const { name, command, cwd } = step;
			const rerun = rerunCommand(step);
			const elapsed = startTimer();
			let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
			try {
				child = Bun.spawn(command, {
					cwd: cwd ? join(root, cwd) : root,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: childProcessEnv(),
				});
			} catch (error) {
				const reason = `could not start: ${getErrorMessage(error)}`;
				finish(name, elapsed, { reason, rerun });
				return 127;
			}
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) {
				const output = `${stdout}${stderr}`.trim().split("\n");
				print(output.slice(-OUTPUT_TAIL_LINES).join("\n"));
			}
			const reason = child.signalCode
				? `killed by ${child.signalCode}`
				: `exit ${code}`;
			finish(name, elapsed, code === 0 ? undefined : { reason, rerun });
			return code;
		},
		inline(name: string, problems: string[], rerun: string) {
			const elapsed = startTimer();
			for (const problem of problems) print(problem);
			const failure =
				problems.length > 0
					? { reason: `${problems.length} problems`, rerun }
					: undefined;
			finish(name, elapsed, failure);
		},
	};
}

function stagedFiles(root: string): string[] {
	const result = Bun.spawnSync(
		["git", "diff", "--cached", "--name-only", "--relative", "--diff-filter=d"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0)
		throw new CliError("check --staged: git could not list staged files.");
	return result.stdout.toString().split("\n").filter(Boolean);
}

/** `bun install` when `bun.lock` changed since the last one this ran. */
async function ensureInstalled(
	root: string,
	run: (step: Step) => Promise<number>,
) {
	const lock = Bun.file(join(root, "bun.lock"));
	if (!(await lock.exists())) return;
	const hash = Bun.hash(await lock.text()).toString();
	const stamp = Bun.file(join(root, "node_modules", ".buncargo-lock-hash"));
	if ((await stamp.exists()) && (await stamp.text()) === hash) return;
	// Stamped only on success, or a failed install is never retried.
	const code = await run({ name: "bun install", command: ["bun", "install"] });
	if (code === 0) await Bun.write(stamp, hash);
}

export async function handleCheck(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(CHECK_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const base = readStringFlag(args, FLAGS.base, errors);
	const staged = readBooleanFlag(args, FLAGS.staged);
	const all = readBooleanFlag(args, FLAGS.all);
	const positionals = readPositionals(CHECK_COMMAND_SPEC, args);
	const docsOnly = positionals[0] === "docs";
	errors.push(
		...findUnknownFlags(CHECK_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
		...positionals
			.slice(docsOnly ? 1 : 0)
			.map((token) => `Unexpected argument: ${token}`),
	);
	if (staged && all) errors.push("--staged and --all cannot be combined.");
	if (base !== undefined && (staged || all))
		errors.push("--base only applies to the default changed-files mode.");
	if (errors.length > 0) throw argumentsError(errors, "check");

	const root = findMonorepoRoot();
	const settings = await loadCheckConfig(root);
	if (settings.errors.length > 0)
		throw new CliError(settings.errors[0] ?? "Invalid check config.", [
			...settings.errors.slice(1),
		]);
	if (settings.warning) console.warn(settings.warning);
	const config = settings.config ?? {};
	const docPaths = docPathsConfig(config.docs);

	if (docsOnly) {
		const problems = findDocProblems(root, markdownFiles(root), docPaths);
		for (const problem of problems) console.error(formatDocProblem(problem));
		return problems.length > 0 ? 1 : 0;
	}
	const mode: CheckMode = all ? "all" : staged ? "staged" : "changed";
	const steps = stepRunner(root, console.log);

	await ensureInstalled(root, steps.run);

	const files: string[] = typedSwitch(mode, {
		all: () => [],
		staged: () => stagedFiles(root),
		changed: () => {
			try {
				return changedFilesSince(root, base);
			} catch (error) {
				throw new CliError(
					getErrorMessage(error).replace("--changed", "check"),
					["Pass --base=<ref>, or --all to check everything."],
				);
			}
		},
	});
	if (mode !== "all" && files.length === 0) {
		console.log("nothing changed: PASS");
		return 0;
	}

	// Deleted paths select workspaces below; the formatters cannot read them.
	const existing = files.filter((file) => existsSync(join(root, file)));

	// Formatting before Biome, so the lint sees the formatted files. From the
	// root: bun fmt skips `.prettierignore` entries only there.
	if (config.format)
		for (const step of formatCommands(config.format, existing, mode))
			await steps.run(step);

	if (BIOME_CONFIGS.some((file) => existsSync(join(root, file)))) {
		if (mode === "all")
			await steps.run({ name: "biome", command: ["bunx", "biome", "check"] });
		else {
			const write = mode === "staged" ? [] : ["--write"];
			const label = mode === "staged" ? "biome" : "biome --write";
			for (const chunk of chunkArray(existing, FILE_CHUNK)) {
				await steps.run({
					name: `${label} (${chunk.length} files)`,
					command: [
						"bunx",
						"biome",
						"check",
						...write,
						"--files-ignore-unknown=true",
						"--no-errors-on-unmatched",
						...chunk,
					],
				});
			}
		}
	}

	if (config.docs !== false && touches(files, ["**/*.md", "*.md"], mode))
		steps.inline(
			"docs",
			findDocProblems(root, markdownFiles(root), docPaths).map(
				formatDocProblem,
			),
			"buncargo check docs",
		);

	// The typecheck picks the changed workspaces and their dependents, and
	// waits for one of the machine-wide check slots. Staged mode compares the
	// working tree with HEAD.
	const cli = buncargoCli();
	const changedRef = mode === "staged" ? "HEAD" : base;
	const changedFlag = changedRef ? `--changed=${changedRef}` : "--changed";
	const changed = mode === "all" ? [] : [changedFlag];
	await steps.run({
		name: "typecheck",
		command: [
			cli.program,
			...(cli.script ? [cli.script] : []),
			"typecheck",
			...changed,
		],
	});

	for (const gate of selectGates(config.gates ?? [], files, mode))
		await steps.run({
			name: gate.name,
			command: ["sh", "-c", gate.command],
			cwd: gate.cwd,
		});

	// The tests next to the changed files are a handful: light enough to run
	// without a slot.
	if (mode === "changed") {
		const tests = await testsFor(root, files, config.testExclude);
		if (tests.length > 0)
			await steps.run({
				name: `tests (${tests.length} files)`,
				command: [
					"sh",
					"-c",
					`${config.testCommand ?? "bun test"} "$@"`,
					"sh",
					...tests.map((test) => `./${test}`),
				],
			});
		else console.log("- no tests next to the changed files");
	}

	for (const line of formatFailureDigest(steps.failures)) console.log(line);
	return steps.failures.length > 0 ? 1 : 0;
}
