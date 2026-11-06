import { describe, expect, it } from "bun:test";
import {
	isContainerLive,
	isContainerServing,
	isContainerStopped,
	parseContainerState,
	startupVerdict,
} from "./container-state";

describe("container states", () => {
	it("reads both runtimes' words, whatever their case", () => {
		expect(parseContainerState("Running")).toBe("running");
		expect(parseContainerState("exited")).toBe("stopped");
		expect(parseContainerState("Dead")).toBe("stopped");
		expect(parseContainerState("stopped")).toBe("stopped");
		expect(parseContainerState("removing")).toBe("stopping");
		expect(parseContainerState("stopping")).toBe("stopping");
		expect(parseContainerState("initializing")).toBe("unknown");
	});

	it("counts a paused or restarting container as live but not serving", () => {
		for (const word of ["paused", "restarting"]) {
			const state = parseContainerState(word);
			expect(isContainerLive(state)).toBe(true);
			expect(isContainerServing(state)).toBe(false);
			expect(isContainerStopped(state)).toBe(false);
		}
	});

	it("never reads a state it does not know as stopped", () => {
		const state = parseContainerState("");
		expect(isContainerLive(state)).toBe(true);
		expect(isContainerStopped(state)).toBe(false);
		expect(isContainerServing(state)).toBe(false);
	});

	it("reads created and exited containers as holding nothing", () => {
		for (const word of ["created", "exited", "dead", "stopped"]) {
			expect(isContainerLive(parseContainerState(word))).toBe(false);
			expect(isContainerStopped(parseContainerState(word))).toBe(true);
		}
	});
});

describe("startupVerdict", () => {
	it("fails a container that is gone", () => {
		for (const state of ["exited", "stopped", "Dead", "removing"])
			expect(startupVerdict({ state }, 0).kind).toBe("stopped");
	});

	it("keeps polling for a state that has not been seen before", () => {
		// The safe direction: an unfamiliar state must not abort a startup that
		// would have succeeded.
		for (const state of ["running", "created", "initializing"])
			expect(startupVerdict({ state }, 0).kind).toBe("pending");
	});

	it("calls a service seen restarting twice a crash loop, not once", () => {
		const restarting = { state: "restarting", exitCode: 1 };
		expect(startupVerdict(restarting, 1).kind).toBe("pending");
		expect(startupVerdict(restarting, 2).kind).toBe("crash-loop");
	});
});
