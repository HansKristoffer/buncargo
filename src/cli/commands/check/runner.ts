import { join } from "node:path";
import { getErrorMessage, startTimer } from "hanzio";
import {
	describePass,
	findReusedSummary,
	passKey,
	type RecordedPasses,
	reusablePass,
} from "../../../core/check-passes";
import { childProcessEnv } from "../../../core/child-env";
import { shellQuote } from "../../../core/shell-quote";
import type { CommandStep, DeferredTests, InlineStep, Step } from "./plan";

const OUTPUT_TAIL_LINES = 80;

/** A step that failed: what the verdict at the end of `check` names. */
export interface StepFailure {
	/** What `--only` calls the step, and the verdict's last line. */
	name: string;
	/** The step line's text, which also counts a chunk's files. */
	label: string;
	/** The exit code, or why the command could not start (`E2BIG: …`). */
	reason: string;
	/** How to run it again by hand, from the repository root. */
	rerun: string;
}

/** Past this a rerun command shows its first arguments and a count. */
const RERUN_MAX_CHARS = 160;

/** The command to rerun one step, cut short when it lists many files. */
export function rerunCommand(step: {
	command: string[];
	cwd?: string;
}): string {
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

/** How to run any step again by hand. */
export function stepRerun(step: Step): string {
	return step.kind === "command" ? rerunCommand(step) : step.rerun;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What ends `check` on a failure: the last line of its output. */
const FAIL_PREFIX = "FAIL: ";

/**
 * The last lines `check` prints: each failed step with its exit code and the
 * command to rerun it, the steps a failure kept from running, the tests it
 * left out, and then the verdict alone on the last line, exactly `PASS` or
 * `FAIL: <step names>`, so `buncargo check | tail -1` is the whole answer.
 * The names are the ones `--only` takes. Strict deferred tests fail it.
 */
export function formatVerdict(
	failures: readonly StepFailure[],
	deferred?: DeferredTests,
	notRun: readonly string[] = [],
): string[] {
	const notRunTests = deferred
		? `${plural(deferred.files.length, "test file")} not run`
		: undefined;
	const failed = new Set(failures.map((failure) => failure.name));
	if (deferred?.strict) failed.add("tests");
	return [
		...failures.map(
			(failure) =>
				`  ✗ ${failure.label} (${failure.reason}) · rerun: ${failure.rerun}`,
		),
		...(notRun.length > 0
			? [
					`  - stopped at the first failure, not run: ${notRun.join(", ")} (--keep-going runs every step)`,
				]
			: []),
		...(deferred
			? [`  - ${notRunTests}, they need services: ${deferred.command}`]
			: []),
		failed.size > 0 ? `${FAIL_PREFIX}${[...failed].join(", ")}` : "PASS",
	];
}

/** Whether the verdict fails the check. */
export function verdictFails(
	failures: readonly StepFailure[],
	deferred?: DeferredTests,
): boolean {
	return failures.length > 0 || deferred?.strict === true;
}

const BUN_TEST_RESULT = /^\((pass|fail|skip|todo)\) /;
const BUN_TEST_FILE = /^\S.*\.(test|spec)\.[cm]?[jt]sx?:$/;
const BUN_TEST_TOTAL =
	/^\s*\d+ (pass|fail|skip|todo|snapshots?|expect\(\) calls)\b|^Ran \d+ tests?\b/;

/**
 * The failed tests in `bun test` output, each with its error, then the
 * totals; undefined when the output has no `(fail)` line to show. The tail
 * of a long run is the last file's passes and the totals, never the error.
 */
export function bunTestFailures(output: string): string[] | undefined {
	const lines: string[] = [];
	let file: string | undefined;
	let fileShown = false;
	let block: string[] = [];
	let failed = false;
	for (const line of output.split("\n")) {
		if (BUN_TEST_FILE.test(line)) {
			file = line;
			fileShown = false;
			block = [];
		} else if (BUN_TEST_RESULT.test(line)) {
			if (line.startsWith("(fail) ")) {
				failed = true;
				if (file && !fileShown) lines.push(file);
				fileShown = true;
				lines.push(...block, line);
			}
			block = [];
		} else if (BUN_TEST_TOTAL.test(line)) lines.push(line);
		else block.push(line);
	}
	return failed ? lines : undefined;
}

/** `::error` and `::group` text, escaped as GitHub's workflow commands read it. */
function escapeWorkflowData(text: string): string {
	return text
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
}

function escapeWorkflowProperty(text: string): string {
	return escapeWorkflowData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** One run of a command; a command that could not start is 127. */
async function attempt(
	command: string[],
	cwd: string,
): Promise<{ code: number; reason: string; output: string }> {
	let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
	try {
		child = Bun.spawn(command, {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: childProcessEnv(),
		});
	} catch (error) {
		const reason = `could not start: ${getErrorMessage(error)}`;
		return { code: 127, reason, output: "" };
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const reason = child.signalCode
		? `killed by ${child.signalCode}`
		: `exit ${code}`;
	return { code, reason, output: `${stdout}${stderr}`.trim() };
}

/** The passes a run may reuse, and how it reads the tree they stand for. */
export interface StepReuse {
	passes: RecordedPasses;
	/** The working tree now ({@link treeFingerprint}); a step may have written. */
	tree: () => string | undefined;
}

/** A command step that passed, and the tree it started on. */
interface StepPass {
	key: string;
	tree: string;
}

/**
 * Runs steps one at a time: one line per step, the output of a failing one,
 * and the failures for the verdict. A step passes on exit code 0 and nothing
 * else: a command that cannot even start (`E2BIG`, not installed) fails, and
 * so does one killed by a signal.
 *
 * With `reuse`, a command that passed on this exact tree is not run again:
 * its line names the run it passed in. A step with `reuse: false` always
 * runs; the typecheck is one, and its line repeats what it reused itself.
 *
 * In GitHub Actions each step is a collapsed `::group::`, a failure prints
 * its whole output and an `::error` annotation; elsewhere it prints the last
 * lines, or for `bun test` the failed tests and the totals.
 */
export function stepRunner(
	root: string,
	print: (line: string) => void,
	{ github, reuse }: { github: boolean; reuse?: StepReuse },
) {
	const failures: StepFailure[] = [];
	const passed: StepPass[] = [];
	let tree = reuse?.tree();

	const showOutput = (output: string, bunTest: boolean) => {
		if (!output) return;
		const lines = output.split("\n");
		const shown = github
			? lines
			: ((bunTest ? bunTestFailures(output) : undefined) ??
				lines.slice(-OUTPUT_TAIL_LINES));
		print(shown.join("\n"));
	};

	const finish = (
		step: Step,
		elapsed: () => number,
		failure: Pick<StepFailure, "reason"> | undefined,
		note?: string,
	) => {
		if (github) print("::endgroup::");
		const seconds = (elapsed() / 1000).toFixed(1);
		if (!failure) {
			const suffix = note ? ` · ${note}` : "";
			print(`✓ ${step.label} ${seconds}s${suffix}`);
			return;
		}
		const rerun = stepRerun(step);
		print(`✗ ${step.label} ${seconds}s (${failure.reason})`);
		if (github)
			print(
				`::error title=${escapeWorkflowProperty(step.name)}::${escapeWorkflowData(`${failure.reason} · rerun: ${rerun}`)}`,
			);
		failures.push({
			name: step.name,
			label: step.label,
			reason: failure.reason,
			rerun,
		});
	};

	const begin = (step: Step) => {
		if (github) print(`::group::${escapeWorkflowData(step.label)}`);
		return startTimer();
	};

	/** Runs the step, with its `fix` and one more try when it fails. */
	const execute = async (step: CommandStep): Promise<number> => {
		const elapsed = begin(step);
		const cwd = step.cwd ? join(root, step.cwd) : root;
		let result = await attempt(step.command, cwd);
		if (result.code !== 0 && step.fix) {
			print(
				`… ${step.label} failed; running its fix: ${rerunCommand({ command: step.fix })}`,
			);
			const fix = await attempt(step.fix, cwd);
			if (fix.code !== 0) {
				showOutput(fix.output, false);
				finish(step, elapsed, { reason: `fix: ${fix.reason}` });
				return fix.code;
			}
			result = await attempt(step.command, cwd);
			if (result.code === 0)
				print(`fixed by ${rerunCommand({ command: step.fix })}`);
		}
		if (result.code !== 0) showOutput(result.output, step.bunTest === true);
		// The typecheck's own account of the workspaces it did not check again.
		const note =
			step.reuse === false ? findReusedSummary(result.output) : undefined;
		finish(step, elapsed, result.code === 0 ? undefined : result, note);
		return result.code;
	};

	return {
		failures,
		/**
		 * The steps whose pass stands for the tree as it is now. One that ran
		 * before another step wrote a file checked a tree that is gone.
		 */
		passedOnTree(): { keys: string[]; tree: string | undefined } {
			const onTree = passed.filter((pass) => pass.tree === tree);
			return { keys: onTree.map((pass) => pass.key), tree };
		},
		/**
		 * Resolves to the step's exit code; a command that could not start is
		 * 127. A failing step with a `fix` runs it and is checked once more.
		 */
		async run(step: CommandStep): Promise<number> {
			const key = passKey(step.command, step.cwd);
			const pass =
				reuse && step.reuse !== false
					? reusablePass(reuse.passes, key, tree, Date.now())
					: undefined;
			if (pass) {
				print(`✓ ${step.label} reused (${describePass(pass, Date.now())})`);
				return 0;
			}

			const treeBefore = tree;
			const code = await execute(step);
			// Read again: the step, or its fix, may have written files.
			tree = reuse?.tree();
			if (code === 0 && treeBefore !== undefined && step.reuse !== false)
				passed.push({ key, tree: treeBefore });
			return code;
		},
		/** A step `check` does itself: it fails with any problem. */
		inline(step: InlineStep, problems: readonly string[]) {
			const elapsed = begin(step);
			for (const problem of problems) print(problem);
			const failure =
				problems.length > 0
					? { reason: plural(problems.length, "problem") }
					: undefined;
			finish(step, elapsed, failure);
		},
	};
}
