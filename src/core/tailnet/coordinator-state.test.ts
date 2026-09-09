import { expect, test } from "bun:test";
import { readProcessIdentity } from "../process-identity";
import { type CoordinatorState, isCoordinatorReady } from "./coordinator-state";

test("saved readiness requires a recent heartbeat from the same live process", () => {
	const now = Date.now();
	const identity = readProcessIdentity(process.pid);
	if (!identity) throw new Error("Cannot read test process identity");
	const state: CoordinatorState = {
		pid: process.pid,
		identity,
		bundle: "/test/tailnetd.js",
		updatedAt: now,
		ready: true,
		cli: { program: process.execPath },
	};
	expect(isCoordinatorReady(state, now)).toBe(true);
	expect(isCoordinatorReady(undefined, now)).toBe(false);
	expect(isCoordinatorReady({ ...state, ready: false }, now)).toBe(false);
	expect(
		isCoordinatorReady({ ...state, identity: "another-process" }, now),
	).toBe(false);
	for (const offset of [-11000, 11000])
		expect(isCoordinatorReady({ ...state, updatedAt: now + offset }, now)).toBe(
			false,
		);
});
