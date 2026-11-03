import { afterEach, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { readCurrentProcessIdentity } from "../../core/process-identity";
import { getRunsPath, publishRun } from "../../core/run-registry";
import { DETACHED_IDLE_LIMIT_MS } from "../../core/watchdog-constants";
import { handleRuns } from "./runs";

// The test preload gives the run a temporary HOME, so this is not the real registry.
afterEach(() => rmSync(getRunsPath(), { force: true }));

it("says in --json when a detached run stops if nothing uses it", async () => {
	const startedAt = new Date(Date.now() - 60_000).toISOString();
	await publishRun({
		sessionId: "detached",
		projectPrefix: "demo",
		projectName: "demo",
		root: "/nowhere/demo",
		worktree: null,
		pid: process.pid,
		processIdentity: readCurrentProcessIdentity(),
		startedAt,
		updatedAt: startedAt,
		detached: true,
		idleLimitMs: DETACHED_IDLE_LIMIT_MS,
		hosts: null,
		cli: { program: "bun" },
		apps: [],
		services: [],
	});
	const printed: string[] = [];
	const log = spyOn(console, "log").mockImplementation((line) => {
		printed.push(String(line));
	});
	try {
		await handleRuns(["--json"]);
	} finally {
		log.mockRestore();
	}
	const { runs } = JSON.parse(printed.join("\n"));
	expect(runs[0].idleStopsAt).toBe(
		new Date(Date.parse(startedAt) + DETACHED_IDLE_LIMIT_MS).toISOString(),
	);
});
