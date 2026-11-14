import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passKey, type RecordedPasses } from "../../../core/check-passes";
import type { CommandStep } from "./plan";
import {
	bunTestFailures,
	formatVerdict,
	rerunCommand,
	stepRunner,
} from "./runner";

function step(name: string, script: string, extra: Partial<CommandStep> = {}) {
	return {
		kind: "command",
		name,
		label: name,
		command: ["sh", "-c", script],
		...extra,
	} satisfies CommandStep;
}

function runner(github: boolean) {
	const printed: string[] = [];
	const steps = stepRunner(tmpdir(), (line) => printed.push(line), { github });
	return { printed, steps };
}

// A format step printed "✓ bun fmt (19 files)" over a command that never ran;
// the verdict has to come from the exit code and land at the very end.
it("fails a step that exits non-zero, is killed or cannot start, and names each at the end", async () => {
	const { printed, steps } = runner(false);

	expect(await steps.run(step("ok", "true"))).toBe(0);
	expect(
		await steps.run(
			step("fmt", "echo 'E2BIG: argument list too long' >&2; exit 2"),
		),
	).toBe(2);
	await steps.run(step("killed", "kill -9 $$"));
	await steps.run({
		kind: "command",
		name: "huge",
		label: "huge",
		command: ["true", "x".repeat(3_000_000)],
	});
	steps.inline(
		{ kind: "docs", name: "docs", label: "docs", rerun: "buncargo check docs" },
		[],
	);

	expect(printed[0]).toStartWith("✓ ok ");
	expect(printed).toContain("E2BIG: argument list too long");
	expect(steps.failures.map(({ name, reason }) => [name, reason])).toEqual([
		["fmt", "exit 2"],
		["killed", "killed by SIGKILL"],
		[
			"huge",
			expect.stringMatching(/^could not start: E2BIG/) as unknown as string,
		],
	]);

	const verdict = formatVerdict(steps.failures);
	expect(verdict[0]).toBe(
		"  ✗ fmt (exit 2) · rerun: sh -c 'echo '\\''E2BIG: argument list too long'\\'' >&2; exit 2'",
	);
	expect(verdict.at(-1)).toBe("FAIL: fmt, killed, huge");
	expect(formatVerdict([])).toEqual(["PASS"]);
});

// Agents read `check | tail -1`: one grepped for `FAIL|passed`, saw nothing on
// a `PASS` and reran a 47 s check for its exit code.
describe("the verdict", () => {
	const deferred = {
		files: ["a.database.test.ts", "b.database.test.ts"],
		command: "bunx buncargo ci -- bun test",
		strict: false,
	};
	const failure = (name: string, label = name) => ({
		name,
		label,
		reason: "exit 1",
		rerun: `run ${name}`,
	});

	it("is the last line, exactly PASS, with the tests left out above it", () => {
		expect(formatVerdict([], deferred)).toEqual([
			"  - 2 test files not run, they need services: bunx buncargo ci -- bun test",
			"PASS",
		]);
	});

	it("is the last line, FAIL: and the names --only takes, each once", () => {
		const lines = formatVerdict(
			[
				failure("biome", "biome --write (200 files)"),
				failure("biome", "biome --write (12 files)"),
				failure("i18n"),
			],
			{ ...deferred, strict: true },
			["typecheck", "tests"],
		);
		expect(lines.at(-1)).toBe("FAIL: biome, i18n, tests");
		expect(lines).toContain(
			"  ✗ biome --write (12 files) (exit 1) · rerun: run biome",
		);
		expect(lines).toContain(
			"  - stopped at the first failure, not run: typecheck, tests (--keep-going runs every step)",
		);
	});
});

describe("a step that passed on this exact tree", () => {
	const gate = (dir: string) => step("gate", `touch ${join(dir, "ran")}`);
	const recorded = (command: CommandStep, tree: string): RecordedPasses => ({
		[passKey(command.command, command.cwd)]: {
			tree,
			at: Date.now() - 14_000,
			by: "buncargo check",
		},
	});
	const reusing = (passes: RecordedPasses, tree: () => string | undefined) => {
		const printed: string[] = [];
		const steps = stepRunner(tmpdir(), (line) => printed.push(line), {
			github: false,
			reuse: { passes, tree },
		});
		return { printed, steps };
	};

	it("is not run again, and its line names the run it passed in", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-runner-"));
		const { printed, steps } = reusing(recorded(gate(dir), "t1"), () => "t1");

		expect(await steps.run(gate(dir))).toBe(0);

		expect(existsSync(join(dir, "ran"))).toBe(false);
		expect(printed).toEqual([
			expect.stringMatching(
				/^✓ gate reused \(passed 1[45]s ago in `buncargo check`\)$/,
			) as unknown as string,
		]);
	});

	it("runs on another tree, and when the tree cannot be told", async () => {
		for (const tree of ["t2", undefined]) {
			const dir = mkdtempSync(join(tmpdir(), "buncargo-runner-"));
			const { steps } = reusing(recorded(gate(dir), "t1"), () => tree);
			await steps.run(gate(dir));
			expect(existsSync(join(dir, "ran"))).toBe(true);
		}
	});

	it("records a pass only for a step that left the tree as it found it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-runner-"));
		const treeFile = join(dir, "tree");
		writeFileSync(treeFile, "t1");
		const { steps } = reusing({}, () => readFileSync(treeFile, "utf8"));
		// The formatter writes, so what it checked is gone; the failing gate
		// has no pass to record.
		const format = step("format", `printf t2 > ${treeFile}`);
		const lint = step("lint", "true");
		const broken = step("broken", "false");

		await steps.run(format);
		await steps.run(lint);
		await steps.run(broken);

		expect(steps.passedOnTree()).toEqual({
			keys: [passKey(lint.command)],
			tree: "t2",
		});
	});

	it("always runs a step that opts out, and records no pass for it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-runner-"));
		const drift = { ...gate(dir), reuse: false as const };
		const { printed, steps } = reusing(recorded(drift, "t1"), () => "t1");

		await steps.run(drift);

		expect(existsSync(join(dir, "ran"))).toBe(true);
		expect(printed[0]).toMatch(/^✓ gate \d+\.\ds$/);
		expect(steps.passedOnTree().keys).toEqual([]);
	});

	it("always runs the typecheck, which reuses per workspace, and repeats what it reused", async () => {
		const summary = "2 of 2 reused (passed 14s ago in `buncargo check`)";
		const typecheck = step(
			"typecheck",
			`echo 'All typecheck checks passed! Total time: 0.1s (9 files), ${summary}'`,
			{ reuse: false },
		);
		const { printed, steps } = reusing(recorded(typecheck, "t1"), () => "t1");

		await steps.run(typecheck);

		expect(printed).toEqual([
			expect.stringMatching(
				/^✓ typecheck \d+\.\ds · 2 of 2 reused \(passed 14s ago in `buncargo check`\)$/,
			) as unknown as string,
		]);
	});
});

it("shortens a rerun command that lists many files", () => {
	const files = Array.from(
		{ length: 50 },
		(_, index) => `src/file-${index}.ts`,
	);
	const rerun = rerunCommand({
		command: ["bun", "fmt", "--no-script", ...files],
	});
	expect(rerun).toStartWith("bun fmt --no-script src/file-0.ts");
	expect(rerun).toMatch(/ … \(\d+ more arguments\)$/);
	expect(rerun.length).toBeLessThan(200);
	expect(
		rerunCommand({ command: ["sh", "-c", "bun x"], cwd: "apps/api" }),
	).toBe("cd apps/api && sh -c 'bun x'");
});

describe("in GitHub Actions", () => {
	it("wraps each step in a group and annotates a failure with its rerun command", async () => {
		const { printed, steps } = runner(true);
		const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`).join(
			"\\n",
		);

		await steps.run(step("biome", "true"));
		await steps.run(step("codegen", `printf '${lines}\\n'; exit 1`));

		expect(printed[0]).toBe("::group::biome");
		expect(printed[1]).toBe("::endgroup::");
		expect(printed[2]).toStartWith("✓ biome ");
		expect(printed[3]).toBe("::group::codegen");
		// The whole output, not the 80-line tail.
		expect(printed[4]?.split("\n")).toHaveLength(120);
		expect(printed[5]).toBe("::endgroup::");
		expect(printed[7]).toStartWith(
			"::error title=codegen::exit 1 · rerun: sh -c ",
		);
	});
});

describe("a step with a fix", () => {
	it("fails with the fix's reason when the fix itself fails", async () => {
		const { steps } = runner(false);
		const code = await steps.run(
			step("codegen", "exit 1", { fix: ["sh", "-c", "exit 3"] }),
		);
		expect(code).toBe(3);
		expect(steps.failures.map((failure) => failure.reason)).toEqual([
			"fix: exit 3",
		]);
	});
});

describe("bun test output", () => {
	const output = [
		"bun test v1.4.4 (38afee6c8)",
		"",
		"src/a.test.ts:",
		"noise line",
		"error: expect(received).toBe(expected)",
		"      at <anonymous> (src/a.test.ts:3:53)",
		"(fail) grp > fails [0.26ms]",
		"",
		"src/b.test.ts:",
		"(pass) b ok [0.01ms]",
		"error: boom",
		"(fail) b bad [0.06ms]",
		"",
		"src/c.test.ts:",
		"(pass) c ok [0.01ms]",
		"",
		" 3 pass",
		" 2 fail",
		" 2 expect() calls",
		"Ran 5 tests across 3 files. [78.00ms]",
	].join("\n");

	it("keeps each failed test with its error and the totals", () => {
		expect(bunTestFailures(output)).toEqual([
			"src/a.test.ts:",
			"noise line",
			"error: expect(received).toBe(expected)",
			"      at <anonymous> (src/a.test.ts:3:53)",
			"(fail) grp > fails [0.26ms]",
			"src/b.test.ts:",
			"error: boom",
			"(fail) b bad [0.06ms]",
			" 3 pass",
			" 2 fail",
			" 2 expect() calls",
			"Ran 5 tests across 3 files. [78.00ms]",
		]);
	});

	it("leaves output with no failed test to the tail", () => {
		expect(bunTestFailures("error: Cannot find module './x'")).toBeUndefined();
	});
});
