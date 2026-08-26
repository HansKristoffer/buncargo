import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { isProcessAlive } from "./lifecycle";
import {
	classifyPortOccupant,
	formatPortOwner,
	signalProcessTree,
} from "./port-owner";

describe("classifyPortOccupant", () => {
	it("reuses a container from this compose project", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-postgres-1",
						composeProject: "gey-main",
					},
				},
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("reuse");
	});

	it("fails on a foreign container", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "other-postgres-1",
						composeProject: "gey-other",
					},
				},
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("fail");
	});

	it("refuses to reuse this project's container on the other runtime", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-postgres-1",
						composeProject: "gey-main",
						runtime: "docker",
					},
				},
				{ root: "/repo", projectName: "gey-main", runtime: "apple" },
			),
		).toBe("fail");
	});

	it("still reuses this project's container on the selected runtime", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-postgres-1",
						composeProject: "gey-main",
						runtime: "apple",
					},
				},
				{ root: "/repo", projectName: "gey-main", runtime: "apple" },
			),
		).toBe("reuse");
	});

	it("kills an orphan whose cwd is under this repo", () => {
		expect(
			classifyPortOccupant(
				{ pids: [12], command: "vite", cwd: "/repo/apps/web" },
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("kill");
	});

	it("fails on a process from another repo", () => {
		expect(
			classifyPortOccupant(
				{ pids: [12], command: "vite", cwd: "/elsewhere" },
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("fail");
	});
});

describe("formatPortOwner", () => {
	it("names a container and compose project", () => {
		expect(
			formatPortOwner(5173, {
				pids: [],
				container: {
					id: "abc",
					name: "gey-other-platform-1",
					composeProject: "gey-other",
				},
			}),
		).toBe(
			"port 5173 held by container gey-other-platform-1 (project gey-other)",
		);
	});

	it("does not name the runtime when it is the one in use", () => {
		expect(
			formatPortOwner(
				5173,
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-other-platform-1",
						composeProject: "gey-other",
						runtime: "docker",
					},
				},
				{ runtime: "docker" },
			),
		).toBe(
			"port 5173 held by container gey-other-platform-1 (project gey-other)",
		);
	});

	it("names the other runtime and how to stop it", () => {
		const message = formatPortOwner(
			13233,
			{
				pids: [84706],
				command: "com.docker.backend",
				container: {
					id: "abc",
					name: "playground-postgres-1",
					composeProject: "playground",
					runtime: "docker",
				},
			},
			{ runtime: "apple" },
		);
		expect(message).toContain("held by container playground-postgres-1");
		expect(message).toContain("running on Docker");
		expect(message).toContain("configured for Apple container");
		expect(message).toContain("buncargo dev --down --runtime=docker");
		// The daemon process is what made the old message useless.
		expect(message).not.toContain("84706");
	});

	it("reads correctly when the holder is Apple, whose name is not an adjective", () => {
		const message = formatPortOwner(
			13333,
			{
				pids: [17513],
				container: {
					id: "abc",
					name: "playground-postgres",
					composeProject: "playground",
					runtime: "apple",
				},
			},
			{ runtime: "docker" },
		);
		expect(message).toContain("running on Apple container while");
		expect(message).not.toContain("Apple container container");
		expect(message).toContain("buncargo dev --down --runtime=apple");
	});
});

describe("signalProcessTree", () => {
	it("kills a detached child process", async () => {
		const child = spawn("bun", ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		expect(child.pid).toBeDefined();
		if (!child.pid) throw new Error("expected pid");
		signalProcessTree(child.pid, "SIGTERM");
		const started = Date.now();
		while (Date.now() - started < 2000 && isProcessAlive(child.pid)) {
			await Bun.sleep(50);
		}
		expect(isProcessAlive(child.pid)).toBe(false);
	});
});
