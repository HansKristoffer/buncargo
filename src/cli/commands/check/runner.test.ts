import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
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
	expect(verdict[0]).toBe("FAIL: fmt, killed, huge");
	expect(verdict[1]).toBe(
		"  ✗ fmt (exit 2) · rerun: sh -c 'echo '\\''E2BIG: argument list too long'\\'' >&2; exit 2'",
	);
	expect(formatVerdict([])).toEqual(["PASS"]);
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
