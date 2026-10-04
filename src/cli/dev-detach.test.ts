import { describe, expect, it } from "bun:test";
import type { RunEntry } from "../core/run-registry";
import { detachedArgv, settledRun } from "./dev-detach";

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
