import { describe, expect, it } from "bun:test";
import {
	DEV_COMMAND_SPEC,
	destructiveModeGate,
	parseDevArgs,
} from "./dev-flags";

describe("parseDevArgs", () => {
	it("splits passthrough args at --", () => {
		const args = parseDevArgs(["--apps=expoApp", "--", "--clear"]);
		expect(args.appsValue).toBe("expoApp");
		expect(args.passthrough).toEqual(["--clear"]);
		expect(args.unknownFlags).toEqual([]);
	});

	it("treats bare --expose as requested without a value", () => {
		const args = parseDevArgs(["--expose"]);
		expect(args.exposeRequested).toBe(true);
		expect(args.exposeValue).toBeUndefined();
	});

	it("marks migrate, seed and up-only as one-shot modes", () => {
		expect(parseDevArgs(["--migrate"]).oneShot).toBe(true);
		expect(parseDevArgs(["--seed"]).oneShot).toBe(true);
		expect(parseDevArgs(["--up-only"]).oneShot).toBe(true);
		expect(parseDevArgs([]).oneShot).toBe(false);
	});

	it("ignores --expose and --takeover in a one-shot mode and says which", () => {
		const args = parseDevArgs(["--seed", "--expose=api", "--takeover"]);
		expect(args).toMatchObject({
			exposeRequested: false,
			exposeValue: undefined,
			takeover: false,
		});
		expect(args.ignoredFlags.map((line) => line.split(" ")[0])).toEqual([
			"--expose",
			"--takeover",
		]);
		expect(parseDevArgs(["--expose", "--takeover"]).ignoredFlags).toEqual([]);
	});

	it("takes --keep only with --detach", () => {
		expect(parseDevArgs(["--detach", "--keep"])).toMatchObject({
			detach: true,
			keep: true,
			errors: [],
		});
		expect(parseDevArgs(["--keep"]).errors).toEqual([
			"--keep only applies to --detach: a run in a terminal never stops for idling.",
		]);
	});

	it("inverts the negated flags", () => {
		const args = parseDevArgs(["--no-hosts", "--no-docker-autostart"]);
		expect(args.hosts).toBe(false);
		expect(args.dockerAutostart).toBe(false);
	});

	it("defaults to the TUI, and --no-tui opts out", () => {
		expect(parseDevArgs([]).tui).toBe("auto");
		expect(parseDevArgs(["--tui"]).tui).toBe("on");
		expect(parseDevArgs(["--no-tui"]).tui).toBe("off");
	});

	it("reads --replace-stale, which only a start can use", () => {
		expect(parseDevArgs(["--replace-stale"]).replaceStale).toBe(true);
		expect(parseDevArgs([]).replaceStale).toBe(false);
		expect(parseDevArgs(["--replace-stale", "--down"]).errors).toEqual([
			"--replace-stale clears the way for a start; it cannot be combined with --down or --reset.",
		]);
	});

	it("reads --detach=1 as an unknown flag, not as --detach", () => {
		const args = parseDevArgs(["--detach=1"]);
		expect(args.detach).toBe(false);
		expect(args.unknownFlags).toEqual(["--detach=1"]);
	});

	it("reports unknown flags without throwing", () => {
		expect(parseDevArgs(["--nope", "--reset"]).unknownFlags).toEqual([
			"--nope",
		]);
	});

	it("validates --watchdog-timeout", () => {
		expect(parseDevArgs(["--watchdog-timeout=15"]).watchdogTimeoutMinutes).toBe(
			15,
		);

		const invalid = parseDevArgs(["--watchdog-timeout=0"]);
		expect(invalid.watchdogTimeoutMinutes).toBeUndefined();
		expect(invalid.errors).toHaveLength(1);
	});

	it("accepts every container runtime selection for --runtime", () => {
		expect(parseDevArgs(["--runtime=docker"]).runtime).toBe("docker");
		expect(parseDevArgs(["--runtime=apple"]).runtime).toBe("apple");
		expect(parseDevArgs(["--runtime=auto"]).runtime).toBe("auto");
		expect(parseDevArgs([]).runtime).toBeUndefined();
	});

	it("rejects an unknown --runtime value", () => {
		const invalid = parseDevArgs(["--runtime=podman"]);
		expect(invalid.runtime).toBeUndefined();
		expect(invalid.errors).toEqual([
			'--runtime expects one of docker, apple, auto, got "podman".',
		]);
	});

	it("keeps the help text in sync with the parsed flags", () => {
		for (const flag of DEV_COMMAND_SPEC.flags) {
			expect(parseDevArgs([flag.name]).unknownFlags).toEqual([]);
		}
	});
});

describe("parseDevArgs --profile", () => {
	it("reads the profile name", () => {
		expect(parseDevArgs(["--profile=full"]).profile).toBe("full");
		expect(parseDevArgs([]).profile).toBeUndefined();
	});

	// Two ways to pick apps in one command is ambiguous about which wins.
	it("refuses --profile together with --apps", () => {
		expect(parseDevArgs(["--profile=full", "--apps=api"]).errors).toContain(
			"Choose either --apps or --profile, not both.",
		);
	});
});

describe("destructiveModeGate", () => {
	const terminal = { interactive: true, ci: false };
	const agent = { interactive: false, ci: false };

	it("asks in a terminal and refuses without one", () => {
		const reset = parseDevArgs(["--reset"]);
		expect(destructiveModeGate(reset, terminal)).toBe("confirm");
		expect(destructiveModeGate(reset, agent)).toBe("refuse");
		expect(destructiveModeGate(parseDevArgs(["--down", "--all"]), agent)).toBe(
			"refuse",
		);
	});

	it("runs with --yes, in CI, and for a plain --down", () => {
		expect(destructiveModeGate(parseDevArgs(["--reset", "--yes"]), agent)).toBe(
			"run",
		);
		expect(
			destructiveModeGate(parseDevArgs(["--reset"]), {
				interactive: false,
				ci: true,
			}),
		).toBe("run");
		expect(destructiveModeGate(parseDevArgs(["--down"]), agent)).toBe("run");
	});
});
