import { describe, expect, it } from "bun:test";
import type { BuncargoContainer } from "../types";
import { isContainerUp, manualDownCommand } from "./inventory";

const db = { id: "app-db", service: "db" } as BuncargoContainer;
const cache = { id: "app-cache", service: "cache" } as BuncargoContainer;

describe("manualDownCommand", () => {
	it("names the command each runtime removes a stack with, volumes kept", () => {
		expect(
			manualDownCommand({
				projectName: "app",
				runtime: "docker",
				containers: [db, cache],
			}),
		).toBe("docker compose -p app down");
		expect(
			manualDownCommand({
				projectName: "app",
				runtime: "apple",
				containers: [db, cache],
			}),
		).toBe("container delete --force app-db app-cache");
	});
});

describe("isContainerUp", () => {
	const base = {
		id: "a",
		name: "a",
		ports: "",
		project: "p",
		root: "/r",
		worktree: "",
		service: "postgres",
	};

	it("reads the state, not the human status line", () => {
		// "Exited (0) 1 hour ago" and "Up 3 minutes" can both contain the same
		// word as a substring match; only the state separates them.
		expect(
			isContainerUp({ ...base, state: "running", status: "Up 3 minutes" }),
		).toBe(true);
		expect(
			isContainerUp({
				...base,
				state: "exited",
				status: "Exited (0) 1 hour ago",
			}),
		).toBe(false);
	});

	it("reads both runtimes' spellings alike, so Apple needs no second vocabulary", () => {
		expect(
			isContainerUp({ ...base, state: "running", status: "running" }),
		).toBe(true);
		expect(
			isContainerUp({ ...base, state: "stopped", status: "stopped" }),
		).toBe(false);
	});

	it("counts a paused or restarting container as up, since it holds its ports and its stack", () => {
		// Reading it as stopped would let the sweep call the stack abandoned and
		// the allocator hand its ports to another checkout.
		expect(isContainerUp({ ...base, state: "paused", status: "Paused" })).toBe(
			true,
		);
		expect(
			isContainerUp({
				...base,
				state: "restarting",
				status: "Restarting (1) 2 seconds ago",
			}),
		).toBe(true);
	});
});
