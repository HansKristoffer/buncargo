import { describe, expect, it } from "bun:test";
import type { AnyDevEnvironment, CheckContext } from "../types";
import {
	checkFailureError,
	describeCheckFailures,
	isWarning,
	runChecks,
} from "./checks";

const ctx: CheckContext = {
	root: "/repo",
	env: {} as AnyDevEnvironment,
};

describe("runChecks", () => {
	it("reports every result, with a detail when a check gives one", async () => {
		const results = await runChecks(
			[
				{ name: "ok", check: () => true },
				{ name: "types", check: async () => false, fix: "bun run codegen" },
				{
					name: "bun",
					severity: "warning",
					check: () => ({ ok: false, detail: "running 1.2.0" }),
				},
			],
			ctx,
		);
		expect(
			results.map((result) => [result.check.name, result.ok, result.detail]),
		).toEqual([
			["ok", true, undefined],
			["types", false, undefined],
			["bun", false, "running 1.2.0"],
		]);
		expect(
			results.filter(isWarning).map((result) => result.check.name),
		).toEqual(["bun"]);
	});

	// A warning check that passes is no warning; one result's severity wins
	// over its check's.
	it("gives only a failure a severity", async () => {
		const results = await runChecks(
			[
				{ name: "bun", severity: "warning", check: () => true },
				{
					name: "login",
					check: () => ({ ok: false, severity: "warning" }),
				},
				{ name: "types", check: () => false },
			],
			ctx,
		);
		expect(results.map(isWarning)).toEqual([false, true, false]);
		expect(results[2]).toMatchObject({ ok: false, severity: "error" });
	});

	// A precondition that cannot even be evaluated is not met.
	it("counts a check that throws as failed", async () => {
		const [result] = await runChecks(
			[
				{
					name: "broken",
					check: () => {
						throw new Error("boom");
					},
				},
			],
			ctx,
		);
		expect(result).toMatchObject({ ok: false, detail: "boom" });
	});

	it("hands each check the root and environment", async () => {
		let seen: CheckContext | undefined;
		await runChecks(
			[
				{
					name: "root",
					check: (checkCtx) => {
						seen = checkCtx;
						return true;
					},
				},
			],
			ctx,
		);
		expect(seen).toBe(ctx);
	});
});

describe("checkFailureError", () => {
	it("names every fix and points at setup", () => {
		const error = checkFailureError([
			{
				check: { name: "types", check: () => false, fix: "bun run codegen" },
				ok: false,
				severity: "error",
			},
			{
				check: { name: "env", check: () => false },
				ok: false,
				severity: "error",
			},
			{
				check: {
					name: "toml",
					check: () => false,
					fix: () => {},
					fixDescription: "patch shopify.app.toml",
				},
				ok: false,
				detail: "web_directories is empty",
				severity: "error",
			},
		]);
		expect(error.message).toBe("3 checks failed before starting:");
		expect(error.hints).toEqual([
			"types: run `bun run codegen`",
			"env",
			"toml (web_directories is empty): patch shopify.app.toml",
			"Or run `bunx buncargo setup` to run every fix.",
		]);
		expect(describeCheckFailures([])).toEqual([]);
	});
});

describe("dependencies check", () => {
	it("fails a checkout that declares dependencies but never installed them", async () => {
		const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { allChecks } = await import("./core-checks");
		const root = await mkdtemp(join(tmpdir(), "buncargo-deps-"));
		try {
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ devDependencies: { typescript: "5" } }),
			);
			const env = { root, services: {}, apps: {} } as AnyDevEnvironment;
			const deps = allChecks(env).filter(
				(check) => check.name === "Dependencies are installed",
			);
			expect(deps).toHaveLength(1);
			const context = { root, env };
			expect((await runChecks(deps, context))[0]).toMatchObject({
				ok: false,
				detail: "no node_modules",
			});
			await mkdir(join(root, "node_modules"));
			expect((await runChecks(deps, context))[0]?.ok).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("loopback URLs check", () => {
	// Joined with "; " the warning was kilobytes on one line, and it fired in a
	// fresh worktree whose ports were never allocated.
	async function loopbackWarning(provenance: "hash" | "lockfile") {
		const { allChecks } = await import("./core-checks");
		const env = {
			root: "/nonexistent-buncargo-checkout",
			services: {},
			apps: {},
			ports: { api: 3000, web: 5173 },
			portOffsetProvenance: provenance,
			buildEnvVars: () => ({
				API_URL: "http://localhost:3100",
				WEB_URL: "http://localhost:5273/app",
			}),
		} as unknown as AnyDevEnvironment;
		const checks = allChecks(env).filter(
			(check) => check.name === "Loopback URLs point at this checkout",
		);
		const results = await runChecks(checks, { root: env.root, env });
		return describeCheckFailures(results.filter((result) => !result.ok));
	}

	it("lists each stray variable on a line of its own", async () => {
		const [warning] = await loopbackWarning("lockfile");
		const lines = warning?.split("\n") ?? [];
		expect(lines[0]).toBe("Loopback URLs point at this checkout:");
		expect(lines.slice(1).map((line) => line.trim().split(" ")[0])).toEqual([
			"API_URL",
			"WEB_URL",
		]);
		expect(lines[1]).toContain(
			"`buncargo env set API_URL=http://localhost:3000`",
		);
	});

	it("says nothing before the checkout has allocated its ports", async () => {
		expect(await loopbackWarning("hash")).toEqual([]);
	});
});
