import { describe, expect, it } from "bun:test";
import type { AppStateDetail } from "../core/process/run-output";
import { SeedFailedError } from "../environment/seed-startup";
import { CliError } from "./errors";
import {
	describeAppFailure,
	describeDevFailure,
	FAILURE_OUTPUT_LINES,
	formatRunFailure,
} from "./run-failure";

const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);

function output(tails: Record<string, string[]>, failed: string[] = []) {
	const states = new Map<string, AppStateDetail>(
		Object.keys(tails).map((app) => [
			app,
			{ state: failed.includes(app) ? "failed" : "ready" },
		]),
	);
	return { tail: (app: string) => tails[app] ?? [], states };
}

describe("describeDevFailure", () => {
	// An agent re-ran a 200-second `dev` with `grep -B5 -A25` to find which
	// seeder failed.
	it("names a failed seed, with its last lines and the setup warnings", () => {
		const error = new SeedFailedError({
			status: "failed",
			result: { exitCode: 1, stdout: "", stderr: "" },
			command: "bun run db/seed.ts",
			tail: [...lines(30, "seeding"), "dataQualityDuplicatesSeeder failed"],
		});
		const failure = describeDevFailure(error, {
			setupHints: ["Secrets file (.env.local missing): run `bun secrets`"],
		});
		expect(failure.cause).toBe(
			"The seed failed with exit code 1: `bun run db/seed.ts`",
		);
		expect(failure.step).toBe("seed");
		expect(failure.output).toHaveLength(FAILURE_OUTPUT_LINES);
		expect(failure.output.at(-1)).toBe("dataQualityDuplicatesSeeder failed");
		expect(failure.hints).toEqual([
			"Setup checks that warned before the start:",
			"  Secrets file (.env.local missing): run `bun secrets`",
		]);
	});

	// An app that exited with MISSING_SECRETS during start: the agent never
	// saw its output.
	it("names the app an error is about and shows its last lines", () => {
		const failure = describeDevFailure(
			new Error('App "api" exited with code 1'),
			{
				setupHints: [],
				output: output({
					web: ["vite ready"],
					api: ["booting", "MISSING_SECRETS: STRIPE_KEY"],
				}),
			},
		);
		expect(failure).toEqual({
			cause: 'App "api" exited with code 1',
			step: "api",
			output: ["booting", "MISSING_SECRETS: STRIPE_KEY"],
			hints: [],
			next: ["`buncargo logs api` has its whole output"],
		});
	});

	it("falls back to the app that failed when the message names none", () => {
		const failure = describeDevFailure(new Error("Startup failed"), {
			setupHints: [],
			output: output({ web: ["ok"], worker: ["Cannot find module"] }, [
				"worker",
			]),
		});
		expect(failure.step).toBe("worker");
		expect(failure.output).toEqual(["Cannot find module"]);
	});

	it("keeps a CLI error's own hints before the setup warnings", () => {
		const failure = describeDevFailure(
			new CliError("Preflight step shopify login failed.", [
				"Run `shopify auth login`.",
			]),
			{ setupHints: ["Bun 1.4.4 (.bun-version) (running 1.3.0)"] },
		);
		expect(failure).toEqual({
			cause: "Preflight step shopify login failed.",
			output: [],
			hints: [
				"Run `shopify auth login`.",
				"Setup checks that warned before the start:",
				"  Bun 1.4.4 (.bun-version) (running 1.3.0)",
			],
			next: [],
		});
	});
});

describe("formatRunFailure", () => {
	it("puts the cause first, then the output, hints and what to run next", () => {
		const failure = describeAppFailure({
			app: "api",
			reason: "api did not answer http://localhost:3000/health within 60s",
			tail: ["listening on 3001"],
			setupHints: [
				"Loopback URLs point at this checkout:\n     API_URL (.env) uses :3100",
			],
		});
		expect(formatRunFailure(failure)).toEqual({
			message:
				"api did not come up: api did not answer http://localhost:3000/health within 60s",
			hints: [
				"Last lines of api:",
				"  listening on 3001",
				"Setup checks that warned before the start:",
				"  Loopback URLs point at this checkout:",
				"       API_URL (.env) uses :3100",
				"Next: `buncargo logs api` has its whole output; `buncargo restart api` starts it again",
			],
		});
	});
});
