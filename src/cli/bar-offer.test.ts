import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	barDecline,
	isBarOfferDisabled,
	isBarSupported,
} from "../core/menubar";
import {
	canPromptFirstRun,
	claimFirstRunPrompt,
	resetFirstRunPrompt,
} from "../core/prompt";

let home: string;
const realHome = process.env.HOME;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-bar-offer-"));
	process.env.HOME = home;
	resetFirstRunPrompt();
});

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

describe("the menu bar offer's gates", () => {
	it("is macOS only", () => {
		expect(isBarSupported("darwin")).toBe(true);
		expect(isBarSupported("linux")).toBe(false);
		expect(isBarSupported("win32")).toBe(false);
	});

	it("is off in CI and behind BUNCARGO_BAR=0", () => {
		expect(isBarOfferDisabled({ CI: "true" })).toBe(true);
		expect(isBarOfferDisabled({ GITHUB_ACTIONS: "true" })).toBe(true);
		expect(isBarOfferDisabled({ BUNCARGO_BAR: "0" })).toBe(true);
		expect(isBarOfferDisabled({})).toBe(false);
	});

	it("remembers a decline until it is reset", () => {
		expect(barDecline.has()).toBe(false);
		barDecline.persist();
		expect(barDecline.has()).toBe(true);
		barDecline.clear();
		expect(barDecline.has()).toBe(false);
	});

	// A fresh machine can hit the named-hosts setup and this offer in one run.
	// Stacking two setup questions is the onboarding buncargo avoids elsewhere.
	it("lets only one first-run prompt fire per run", () => {
		expect(claimFirstRunPrompt()).toBe(true);
		expect(claimFirstRunPrompt()).toBe(false);
		resetFirstRunPrompt();
		expect(claimFirstRunPrompt()).toBe(true);
	});

	it("never prompts in CI even with a TTY", () => {
		expect(canPromptFirstRun({ env: { CI: "true" } })).toBe(false);
	});

	it("never prompts once declined", () => {
		barDecline.persist();
		expect(canPromptFirstRun({ marker: barDecline, env: {} })).toBe(false);
	});
});
