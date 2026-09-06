import { describe, expect, it } from "bun:test";
import {
	type BarUpdateInput,
	compareVersions,
	decideBarUpdate,
	isCacheFresh,
} from "./bar-update";

/**
 * The two-tier policy from `docs/bar-update-plan.md`, one assertion per row.
 *
 * `decideBarUpdate` is the only thing standing between a schema bump and every
 * installed app showing an empty menu, so each branch is pinned here rather
 * than exercised through `dev`.
 */
const installed = (registryVersion: number, version?: string) => ({
	path: "/Applications/BuncargoBar.app",
	version,
	registryVersion,
});

const decide = (overrides: Partial<BarUpdateInput> = {}) =>
	decideBarUpdate({
		installed: installed(1, "0.2.0"),
		cliRegistryVersion: 1,
		...overrides,
	});

describe("decideBarUpdate", () => {
	it("says nothing when the app is not installed", () => {
		// Installing is the first-run offer's job; the updater stays out of it.
		expect(decide({ installed: undefined, latestVersion: "9.9.9" })).toEqual({
			action: "none",
		});
	});

	it("updates when the app cannot read this CLI's registry", () => {
		expect(
			decide({ installed: installed(1, "0.2.0"), cliRegistryVersion: 2 }),
		).toEqual({ action: "update" });
	});

	// The required tier does not need to know about releases: an app that
	// cannot read the registry is broken whether or not GitHub answered.
	it("updates on a registry gap even with no release information", () => {
		expect(
			decide({
				installed: installed(1),
				cliRegistryVersion: 2,
				latestVersion: undefined,
			}),
		).toEqual({ action: "update" });
	});

	it("hints once when a newer release exists", () => {
		expect(decide({ latestVersion: "0.4.0" })).toEqual({
			action: "hint",
			version: "0.4.0",
		});
		expect(decide({ latestVersion: "0.4.0", hintedVersion: "0.4.0" })).toEqual({
			action: "none",
		});
		// A newer release than the one already hinted speaks up again.
		expect(decide({ latestVersion: "0.5.0", hintedVersion: "0.4.0" })).toEqual({
			action: "hint",
			version: "0.5.0",
		});
	});

	it("stays quiet when the app is current or ahead", () => {
		expect(decide({ latestVersion: "0.2.0" })).toEqual({ action: "none" });
		expect(decide({ latestVersion: "0.1.0" })).toEqual({ action: "none" });
	});

	// A source build is usually ahead of every release; nagging it forever is
	// how a hint becomes noise people learn to ignore.
	it("never nags a source build about releases", () => {
		expect(
			decide({ installed: installed(1, "source"), latestVersion: "9.9.9" }),
		).toEqual({ action: "none" });
		// But a source build too old for the registry is still broken.
		expect(
			decide({
				installed: installed(1, "source"),
				cliRegistryVersion: 2,
				latestVersion: "9.9.9",
			}),
		).toEqual({ action: "update" });
	});

	it("stays quiet when the installed version is unreadable", () => {
		expect(
			decide({ installed: installed(1, undefined), latestVersion: "9.9.9" }),
		).toEqual({ action: "none" });
	});
});

describe("compareVersions", () => {
	it("compares numerically, not as strings", () => {
		// The comparison a string sort gets backwards, and the only one that
		// has to be right.
		expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
	});

	it("treats unparseable segments as zero rather than as newer", () => {
		expect(compareVersions("nonsense", "0.1.0")).toBe(-1);
	});
});

describe("isCacheFresh", () => {
	const now = Date.parse("2026-09-06T12:00:00.000Z");
	const at = (iso: string) => ({ version: 1, checkedAt: iso });

	it("expires the hint tier after a day and the required tier after an hour", () => {
		const twoHoursAgo = at("2026-09-06T10:00:00.000Z");
		expect(isCacheFresh(twoHoursAgo, { required: false, now })).toBe(true);
		expect(isCacheFresh(twoHoursAgo, { required: true, now })).toBe(false);

		const twoDaysAgo = at("2026-09-04T12:00:00.000Z");
		expect(isCacheFresh(twoDaysAgo, { required: false, now })).toBe(false);
	});

	it("refuses a missing, unparseable or future cache", () => {
		expect(isCacheFresh(undefined, { required: false, now })).toBe(false);
		expect(isCacheFresh(at("not a date"), { required: false, now })).toBe(
			false,
		);
		// A clock that jumped back would otherwise freeze the check forever.
		expect(
			isCacheFresh(at("2026-09-07T12:00:00.000Z"), { required: false, now }),
		).toBe(false);
	});
});
