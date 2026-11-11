import { expect, it } from "bun:test";
import { keepCoordinator } from "./dev-connect";

/** Each ensure plays the next outcome; the last one ends the run. */
function coordinatorOutcomes(outcomes: Array<"up" | "gone">) {
	const controller = new AbortController();
	const events: string[] = [];
	let ensured = 0;
	const done = keepCoordinator({
		ensure: async () => {
			const outcome = outcomes[ensured++];
			if (ensured === outcomes.length) controller.abort();
			if (outcome === "gone") throw new Error("coordinator exited");
		},
		intervalMs: 0,
		signal: controller.signal,
		onReady: () => events.push("ready"),
		warn: (reason) => events.push(`warn: ${reason}`),
	});
	return { done, events, ensured: () => ensured };
}

it("ensures the coordinator again after it exits, warning once per outage", async () => {
	const run = coordinatorOutcomes(["up", "gone", "gone", "up", "gone", "up"]);

	await run.done;

	expect(run.ensured()).toBe(6);
	expect(run.events).toEqual([
		"ready",
		"warn: coordinator exited",
		"warn: coordinator exited",
	]);
});

it("announces sharing once the first ensure succeeds after failing", async () => {
	const run = coordinatorOutcomes(["gone", "gone", "up", "up"]);

	await run.done;

	expect(run.events).toEqual(["warn: coordinator exited", "ready"]);
});
