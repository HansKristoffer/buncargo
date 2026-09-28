import { describe, expect, it } from "bun:test";
import { CliError } from "./errors";
import { selectProfileApps } from "./run-cli";

const env = {
	profiles: {
		default: { apps: ["shopify"] },
		full: { apps: ["shopify", "forecast"] },
	},
};

describe("selectProfileApps", () => {
	it("uses the default profile when none is named", () => {
		expect(selectProfileApps(env, undefined)).toEqual(["shopify"]);
	});

	it("uses the named profile", () => {
		expect(selectProfileApps(env, "full")).toEqual(["shopify", "forecast"]);
	});

	// Without a default profile a bare `dev` runs every app, as before.
	it("selects everything without profiles", () => {
		expect(selectProfileApps({}, undefined)).toBeUndefined();
		expect(
			selectProfileApps({ profiles: { full: { apps: ["a"] } } }, undefined),
		).toBeUndefined();
	});

	it("names the available profiles for an unknown one", () => {
		try {
			selectProfileApps(env, "nope");
			throw new Error("expected a CliError");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).hints).toEqual([
				"Available profiles: default, full",
			]);
		}
	});
});
