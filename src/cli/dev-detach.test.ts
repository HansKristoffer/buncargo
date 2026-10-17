import { describe, expect, it } from "bun:test";
import type { RunEntry } from "../core/run-registry";
import { detachedArgv, namedHostsFallbacks, settledRun } from "./dev-detach";

describe("namedHostsFallbacks", () => {
	// The parent prints only the app list, with localhost URLs, so the reason
	// they are not named ones has to be lifted out of the run's own output.
	it("finds the run's named-hosts warnings in its output", () => {
		const output = [
			"  ✓  Postgres ready",
			"  \u001b[33m⚠\u001b[39m  Named URLs unavailable: the daemon on :443 stopped answering. Run `buncargo hosts install`.",
			"  api  http://localhost:3000",
		].join("\n");
		expect(namedHostsFallbacks(output)).toEqual([
			"Named URLs unavailable: the daemon on :443 stopped answering. Run `buncargo hosts install`.",
		]);
	});

	it("finds nothing when named hosts came up", () => {
		expect(namedHostsFallbacks("  api  https://api.app.localhost\n")).toEqual(
			[],
		);
	});
});

describe("detachedArgv", () => {
	it("re-runs the same invocation without --detach", () => {
		expect(
			detachedArgv(
				["bun", "/x/bin.js", "dev", "--detach", "--apps=api"],
				"/bin/bun",
			),
		).toEqual(["/bin/bun", "/x/bin.js", "dev", "--apps=api"]);
	});
});

describe("settledRun", () => {
	const run = (apps: RunEntry["apps"], services: RunEntry["services"] = []) =>
		({ apps, services }) as RunEntry;

	it("waits for every app, and is not fooled by the claim's empty list", () => {
		expect(settledRun(run([]), true)).toBe(false);
		expect(
			settledRun(
				run([
					{ name: "api", status: "ready" },
					{ name: "web", status: "starting" },
				]),
				true,
			),
		).toBe(false);
		expect(
			settledRun(
				run([
					{ name: "api", status: "ready" },
					{ name: "web", status: "failed" },
				]),
				true,
			),
		).toBe(true);
	});

	it("settles a config without apps once its services are ready", () => {
		expect(
			settledRun(run([], [{ name: "postgres", status: "starting" }]), false),
		).toBe(false);
		expect(
			settledRun(run([], [{ name: "postgres", status: "ready" }]), false),
		).toBe(true);
	});
});
