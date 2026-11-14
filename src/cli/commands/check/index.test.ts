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
import { dirname, join } from "node:path";
import { CI_ENV_VARS } from "../../../core/runtime-flags";
import type { CheckPlanJson } from "../../json-documents";

/**
 * `buncargo check` from the real `bin.ts`, in a throwaway git repository
 * whose `dev.config.ts` holds only a `check` key. The change is untracked
 * files against `--base=HEAD`.
 */

const BIN = join(import.meta.dir, "..", "..", "bin.ts");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
	const result = Bun.spawnSync(
		["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
		{ cwd: root },
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A committed repo with this check config, then `changed` written on top. */
function repo(check: unknown, changed: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-check-cli-")));
	roots.push(root);
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default { check: ${JSON.stringify(check)} };\n`,
	);
	git(root, "init", "-q");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	for (const [file, content] of Object.entries(changed)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), content);
	}
	return root;
}

/** A developer's machine: in CI `check` prints workflow commands and reuses nothing. */
function localEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const name of CI_ENV_VARS) delete env[name];
	return env;
}

function check(root: string, args: string[]) {
	const result = Bun.spawnSync([process.execPath, BIN, "check", ...args], {
		cwd: root,
		env: localEnv(),
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

const PASSING_TEST = `import { it } from "bun:test"; it("ok", () => {});\n`;

describe("check --list", () => {
	const gates = [
		{ name: "codegen", command: "true" },
		{ name: "i18n", command: "true", when: ["locales/**"] },
	];

	it("prints every step the change selects, and --only and --skip filter them", () => {
		const root = repo({ gates }, { "src/a.ts": "", "src/a.test.ts": "" });
		const names = (args: string[]) => {
			const base = args.includes("--all") ? [] : ["--base=HEAD"];
			const result = check(root, [...base, "--list", "--json", ...args]);
			expect(result.exitCode).toBe(0);
			const plan = JSON.parse(result.stdout) as CheckPlanJson;
			// CheckPlanJson: a key may be added, never dropped.
			expect(Object.keys(plan).sort()).toEqual([
				"deferredTests",
				"mode",
				"steps",
			]);
			return plan.steps.map((step) => step.name);
		};

		expect(names([])).toEqual(["typecheck", "codegen", "tests"]);
		expect(names(["--only=codegen,tests"])).toEqual(["codegen", "tests"]);
		expect(names(["--skip=typecheck"])).toEqual(["codegen", "tests"]);
		expect(names(["--skip=typecheck", "--all"])).toEqual([
			"docs",
			"codegen",
			"i18n",
		]);
	});

	it("rejects a step name that is neither built in nor a gate", () => {
		const root = repo({ gates }, { "src/a.ts": "" });
		const result = check(root, ["--only=lint"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown check step: lint");
		expect(result.stderr).toContain("codegen, i18n");
	});
});

describe("check testDeferred", () => {
	const changed = {
		"src/a.ts": "",
		"src/a.test.ts": PASSING_TEST,
		// Would fail without its database, which is why it is deferred.
		"src/a.database.test.ts": `import { it } from "bun:test"; it("db", () => { throw new Error("no database"); });\n`,
	};
	const deferred = {
		files: ["**/*.database.test.ts"],
		command: "bunx buncargo ci -- bun test",
	};

	it("runs the other tests, names the deferred file's command and passes", () => {
		const root = repo({ testDeferred: deferred }, changed);
		const result = check(root, ["--base=HEAD", "--skip=typecheck"]);
		expect(result.stdout).toContain("✓ tests (1 files)");
		expect(result.stdout).toEndWith(
			"  - 1 test file not run, they need services: bunx buncargo ci -- bun test ./src/a.database.test.ts\nPASS\n",
		);
		expect(result.exitCode).toBe(0);
	});

	it("fails with strict", () => {
		const root = repo({ testDeferred: { ...deferred, strict: true } }, changed);
		const result = check(root, ["--base=HEAD", "--skip=typecheck"]);
		expect(result.stdout).toEndWith("\nFAIL: tests\n");
		expect(result.exitCode).toBe(1);
	});
});

describe("check gate fix", () => {
	it("runs a failing gate's fix and checks it again", () => {
		const gates = [
			{ name: "codegen", command: "test -f generated", fix: "touch generated" },
		];
		const root = repo({ gates }, { "src/a.ts": "" });
		const result = check(root, ["--base=HEAD", "--skip=typecheck"]);
		expect(existsSync(join(root, "generated"))).toBe(true);
		expect(result.stdout).toContain("✓ codegen");
		expect(result.stdout).toEndWith("PASS\n");
		expect(result.exitCode).toBe(0);
	});
});

describe("check on a failure", () => {
	const gates = [
		{ name: "first", command: "echo first-output; exit 3" },
		{ name: "second", command: "touch second-ran" },
	];

	it("stops at the first failing step and ends with FAIL: and its name", () => {
		const root = repo({ gates }, { "src/a.ts": "" });
		const result = check(root, ["--base=HEAD", "--skip=typecheck"]);

		expect(existsSync(join(root, "second-ran"))).toBe(false);
		expect(result.stdout).toContain("first-output\n✗ first ");
		expect(result.stdout).toContain(
			"  - stopped at the first failure, not run: second (--keep-going runs every step)\n",
		);
		expect(result.stdout).toEndWith("\nFAIL: first\n");
		expect(result.exitCode).toBe(1);
	});

	it("runs every step with --keep-going", () => {
		const root = repo({ gates }, { "src/a.ts": "" });
		const result = check(root, [
			"--base=HEAD",
			"--skip=typecheck",
			"--keep-going",
		]);

		expect(existsSync(join(root, "second-ran"))).toBe(true);
		expect(result.stdout).not.toContain("not run");
		expect(result.stdout).toEndWith("\nFAIL: first\n");
		expect(result.exitCode).toBe(1);
	});
});

// A commit paid for the same gates twice: `check`, then the pre-commit hook's
// `check --staged` seconds later on the tree that had just passed.
describe("check on a tree that already passed", () => {
	/** A gate that counts its runs in a file outside the repository. */
	function counted() {
		const counter = join(
			realpathSync(mkdtempSync(join(tmpdir(), "buncargo-check-count-"))),
			"runs",
		);
		roots.push(dirname(counter));
		const gates = [{ name: "count", command: `echo ran >> ${counter}` }];
		const root = repo({ gates }, { "src/a.ts": "export const a = 1;\n" });
		const runs = () => readFileSync(counter, "utf8").trim().split("\n").length;
		const run = (...args: string[]) =>
			check(root, ["--skip=typecheck", ...args]);
		return { root, runs, run };
	}

	it("reuses the pass in the next check and in the hook's check --staged", () => {
		const { root, runs, run } = counted();

		expect(run("--base=HEAD").stdout).toMatch(/✓ count \d/);
		const again = run("--base=HEAD");
		git(root, "add", "-A");
		const hook = run("--staged");

		expect(runs()).toBe(1);
		for (const result of [again, hook]) {
			expect(result.stdout).toMatch(
				/✓ count reused \(passed \d+s ago in `buncargo check --skip=typecheck --base=HEAD`\)\n/,
			);
			expect(result.stdout).toEndWith("\nPASS\n");
			expect(result.exitCode).toBe(0);
		}
	});

	it("runs again once a file changed, and with --no-reuse", () => {
		const { root, runs, run } = counted();
		run("--base=HEAD");

		writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
		run("--base=HEAD");
		expect(runs()).toBe(2);

		run("--base=HEAD", "--no-reuse");
		expect(runs()).toBe(3);
	});

	it("runs again in CI, which checks what it was given", () => {
		const { root, runs, run } = counted();
		run("--base=HEAD");

		const result = Bun.spawnSync(
			[process.execPath, BIN, "check", "--skip=typecheck", "--base=HEAD"],
			{ cwd: root, env: { ...localEnv(), CI: "true" } },
		);

		expect(result.exitCode).toBe(0);
		expect(runs()).toBe(2);
	});
});

it("check says so and passes when nothing changed", () => {
	const root = repo({}, {});
	const result = check(root, ["--base=HEAD"]);
	expect(result.stdout).toBe("nothing changed\nPASS\n");
	expect(result.exitCode).toBe(0);
});

it("check docs says how many files it read", () => {
	const root = repo(
		{},
		{ "readme.md": "# Hi\n", "docs/a.md": "[x](../readme.md)\n" },
	);
	const result = check(root, ["docs"]);
	expect(result.stdout).toBe("✓ docs: 2 files, 0 problems\n");
	expect(result.exitCode).toBe(0);
});
