import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { isProcessAlive } from "./lifecycle";
import {
	classifyPortOccupant,
	formatPortOwner,
	parseDockerPublishedPort,
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
});

describe("parseDockerPublishedPort", () => {
	it("matches published TCP ports from docker ps", () => {
		expect(parseDockerPublishedPort("0.0.0.0:5532->5432/tcp", 5532)).toBe(true);
		expect(parseDockerPublishedPort("0.0.0.0:5532->5432/tcp", 5432)).toBe(
			false,
		);
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
