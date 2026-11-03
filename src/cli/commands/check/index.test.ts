import { expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { formatFailureDigest, rerunCommand, stepRunner } from "./index";

// A format step printed "✓ bun fmt (19 files)" over a command that never ran;
// the verdict has to come from the exit code and land at the very end.
it("fails a step that exits non-zero, is killed or cannot start, and names each at the end", async () => {
	const printed: string[] = [];
	const steps = stepRunner(tmpdir(), (line) => printed.push(line));

	expect(await steps.run({ name: "ok", command: ["true"] })).toBe(0);
	expect(
		await steps.run({
			name: "fmt",
			command: ["sh", "-c", "echo 'E2BIG: argument list too long' >&2; exit 2"],
		}),
	).toBe(2);
	await steps.run({ name: "killed", command: ["sh", "-c", "kill -9 $$"] });
	await steps.run({
		name: "huge",
		command: ["true", "x".repeat(3_000_000)],
	});
	steps.inline("docs", [], "buncargo check docs");

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

	const digest = formatFailureDigest(steps.failures);
	expect(digest[0]).toBe("FAIL: fmt, killed, huge");
	expect(digest[1]).toBe(
		"  ✗ fmt (exit 2) · rerun: sh -c 'echo '\\''E2BIG: argument list too long'\\'' >&2; exit 2'",
	);
	expect(formatFailureDigest([])).toEqual(["PASS"]);
});

it("shortens a rerun command that lists many files", () => {
	const files = Array.from(
		{ length: 50 },
		(_, index) => `src/file-${index}.ts`,
	);
	const rerun = rerunCommand({
		name: "bun fmt (50 files)",
		command: ["bun", "fmt", "--no-script", ...files],
	});
	expect(rerun).toStartWith("bun fmt --no-script src/file-0.ts");
	expect(rerun).toMatch(/ … \(\d+ more arguments\)$/);
	expect(rerun.length).toBeLessThan(200);
	expect(
		rerunCommand({
			name: "gate",
			command: ["sh", "-c", "bun x"],
			cwd: "apps/api",
		}),
	).toBe("cd apps/api && sh -c 'bun x'");
});
