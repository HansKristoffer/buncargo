import { afterEach, describe, expect, it } from "bun:test";
import { claimFirstRunPrompt, resetFirstRunPrompt } from "../prompt";
import { promptFirstRun, repairStaleService } from "./onboarding";

const REASON =
	"Named-hosts service runs hostsd-6.1.1.js, but this buncargo installs hostsd-7.1.0.js. Run `buncargo hosts install` to update it.";

describe("repairStaleService", () => {
	// The stale daemon is still serving, so this path must never fail the run —
	// only tell the user what will bite them and how to fix it.
	it("carries the reason as a note when there is no TTY to prompt on", async () => {
		let reinstalls = 0;
		const result = await repairStaleService(REASON, {
			reinstall: async () => {
				reinstalls += 1;
			},
			caPath: () => "/ca.pem",
		});
		expect(result).toEqual({ ok: true, caPath: "/ca.pem", notes: [REASON] });
		expect(reinstalls).toBe(0);
	});

	it("reinstalls when the prompt is accepted and drops the note", async () => {
		const prompted: string[] = [];
		let reinstalls = 0;
		const result = await repairStaleService(REASON, {
			prompt: async (reason) => {
				prompted.push(reason);
				return "update";
			},
			reinstall: async () => {
				reinstalls += 1;
			},
			caPath: () => "/ca.pem",
		});
		expect(prompted).toEqual([REASON]);
		expect(reinstalls).toBe(1);
		expect(result).toEqual({ ok: true, caPath: "/ca.pem" });
	});

	it("keeps the note and skips the password prompt when declined", async () => {
		let reinstalls = 0;
		const result = await repairStaleService(REASON, {
			prompt: async () => "skip",
			reinstall: async () => {
				reinstalls += 1;
			},
			caPath: () => "/ca.pem",
		});
		expect(reinstalls).toBe(0);
		expect(result.ok).toBe(true);
		expect(result.ok && result.notes).toEqual([REASON]);
	});

	// A failed reinstall leaves the old daemon serving, so the run continues
	// with named hosts; only the reason reported changes.
	it("reports the failure and stays usable when the reinstall fails", async () => {
		const result = await repairStaleService(REASON, {
			prompt: async () => "update",
			reinstall: async () => {
				throw new Error("sudo: a password is required");
			},
			caPath: () => "/ca.pem",
		});
		expect(result.ok).toBe(true);
		expect(result.ok && result.notes).toEqual(["sudo: a password is required"]);
	});
});

describe("promptFirstRun", () => {
	afterEach(resetFirstRunPrompt);

	// One first-run question per run: the menu bar offer comes next in `dev`.
	it("takes the run's first-run prompt slot when it asks", async () => {
		expect(await promptFirstRun(async () => "decline")).toBe("decline");
		expect(claimFirstRunPrompt()).toBe(false);
	});

	it("skips without asking when another prompt already took the slot", async () => {
		claimFirstRunPrompt();
		let asked = false;
		const choice = await promptFirstRun(async () => {
			asked = true;
			return "setup";
		});
		expect(choice).toBe("skip");
		expect(asked).toBe(false);
	});
});
