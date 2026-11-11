import { describe, expect, it } from "bun:test";
import type { RunEntry } from "../../../core/run-registry";
import { WATCHDOG_OWNER_DEAD_GRACE_MS } from "../../../core/watchdog-constants";
import { describeFinishedRun } from "./ls";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function finished(
	lifecycle: RunEntry["lifecycle"],
	hold: RunEntry["hold"],
): RunEntry {
	return { lifecycle, hold } as RunEntry;
}

describe("describeFinishedRun", () => {
	const threeMinutes = {
		kind: "timed",
		ms: 180_000,
		inherited: false,
	} as const;

	it("counts a released run's hold down", () => {
		const run = finished({ state: "released", at: ago(60_000) }, threeMinutes);
		expect(describeFinishedRun(run, NOW)).toBe("released; held, 2m left");
	});

	it("shows a crashed run inside its grace, which used to show nothing", () => {
		const run = finished({ state: "lost", at: ago(0) }, threeMinutes);
		const minutes = Math.ceil(WATCHDOG_OWNER_DEAD_GRACE_MS / 60_000);
		expect(describeFinishedRun(run, NOW)).toBe(
			`owner gone; held, ${minutes}m left`,
		);
	});

	it("says when the containers are kept for the checkout, or already due", () => {
		const kept = finished(
			{ state: "released", at: ago(60_000) },
			{ kind: "checkout" },
		);
		expect(describeFinishedRun(kept, NOW)).toBe(
			"released; held until this checkout is removed",
		);
		const due = finished({ state: "released", at: ago(600_000) }, threeMinutes);
		expect(describeFinishedRun(due, NOW)).toBe("released; held, removal due");
	});
});
