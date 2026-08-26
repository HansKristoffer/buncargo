import { describe, expect, it } from "bun:test";
import { DEV_COMMAND_SPEC, parseDevArgs } from "./dev-flags";

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

	it("inverts the negated flags", () => {
		const args = parseDevArgs(["--no-hosts", "--no-docker-autostart"]);
		expect(args.hosts).toBe(false);
		expect(args.dockerAutostart).toBe(false);
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

	it("keeps the help text in sync with the parsed flags", () => {
		for (const flag of DEV_COMMAND_SPEC.flags) {
			expect(parseDevArgs([flag.name]).unknownFlags).toEqual([]);
		}
	});
});
