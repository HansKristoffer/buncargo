import { describe, expect, it } from "bun:test";
import {
	type DevArgs,
	destructiveModeGate,
	exposeRequested,
	ignoredFlagWarnings,
	parseDevArgs,
	requestedApps,
	tuiMode,
} from "./dev-flags";
import { ArgumentsError } from "./errors";

function dev(argv: string[]): DevArgs {
	const parsed = parseDevArgs(argv);
	if (parsed.help) throw new Error("help");
	return parsed;
}

function devErrors(argv: string[]): string[] {
	try {
		parseDevArgs(argv);
	} catch (error) {
		if (!(error instanceof ArgumentsError)) throw error;
		return [error.message, ...error.hints.slice(0, -1)];
	}
	return [];
}

describe("parseDevArgs", () => {
	// `buncargo dev api` started every app.
	it("selects the apps named as arguments, as --apps does", () => {
		expect(requestedApps(dev(["api", "web", "--", "--clear"]))).toEqual([
			"api",
			"web",
		]);
		expect(requestedApps(dev(["--apps=api, web"]))).toEqual(["api", "web"]);
		expect(requestedApps(dev([]))).toBeUndefined();
	});

	// Two ways to pick apps in one command is ambiguous about which wins.
	it("refuses two ways of picking apps at once", () => {
		expect(devErrors(["api", "--apps=web"])).toEqual([
			"Name the apps as arguments or with --apps, not both.",
		]);
		expect(devErrors(["api", "--profile=full"])).toEqual([
			"Choose either apps or --profile, not both.",
		]);
		expect(devErrors(["--apps=,"])).toEqual([
			"--apps requires at least one app name.",
		]);
	});

	it("ignores --expose and --takeover in a one-shot mode and says which", () => {
		const args = dev(["--seed", "--expose=api", "--takeover"]);
		expect(exposeRequested(args.values)).toBe(false);
		expect(
			ignoredFlagWarnings(args.values).map((line) => line.split(" ")[0]),
		).toEqual(["--expose", "--takeover"]);
		const start = dev(["--expose", "--takeover"]);
		expect(exposeRequested(start.values)).toBe(true);
		expect(ignoredFlagWarnings(start.values)).toEqual([]);
	});

	it("takes --keep and --json only with --detach", () => {
		expect(dev(["--detach", "--keep", "--json"]).values).toMatchObject({
			detach: true,
			keep: true,
			json: true,
		});
		expect(devErrors(["--keep", "--json"])).toEqual([
			"--keep only applies to --detach: a run in a terminal never stops for idling.",
			"--json only applies to --detach; a run in a terminal prints its own output.",
		]);
	});

	it("refuses modes that contradict each other", () => {
		expect(devErrors(["--replace-stale", "--down"])).toEqual([
			"--replace-stale clears the way for a start; it cannot be combined with --down or --reset.",
		]);
		expect(devErrors(["--detach", "--seed"])).toEqual([
			"--detach runs the dev servers in the background; it cannot be combined with --tui, --attach or a one-shot mode.",
		]);
	});

	it("defaults to the TUI, and --no-tui opts out", () => {
		expect(tuiMode(dev([]).values)).toBe("auto");
		expect(tuiMode(dev(["--tui"]).values)).toBe("on");
		expect(tuiMode(dev(["--no-tui"]).values)).toBe("off");
	});
});

describe("destructiveModeGate", () => {
	const terminal = { interactive: true, ci: false };
	const agent = { interactive: false, ci: false };

	it("asks in a terminal and refuses without one", () => {
		const reset = dev(["--reset"]).values;
		expect(destructiveModeGate(reset, terminal)).toBe("confirm");
		expect(destructiveModeGate(reset, agent)).toBe("refuse");
		expect(destructiveModeGate(dev(["--down", "--all"]).values, agent)).toBe(
			"refuse",
		);
	});

	it("runs with --yes, in CI, and for a plain --down", () => {
		expect(destructiveModeGate(dev(["--reset", "--yes"]).values, agent)).toBe(
			"run",
		);
		expect(
			destructiveModeGate(dev(["--reset"]).values, {
				interactive: false,
				ci: true,
			}),
		).toBe("run");
		expect(destructiveModeGate(dev(["--down"]).values, agent)).toBe("run");
	});
});
