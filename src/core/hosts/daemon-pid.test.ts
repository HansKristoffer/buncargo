import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonPid, releaseDaemonPid, writeDaemonPid } from "./daemon-pid";

let home: string;
const originalHome = process.env.HOME;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-daemon-pid-test-"));
	process.env.HOME = home;
});

afterEach(() => {
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
});

describe("releaseDaemonPid", () => {
	// An idle exit used to leave the pidfile behind, naming a dead pid.
	it("forgets the daemon that is exiting", () => {
		writeDaemonPid(process.pid);
		releaseDaemonPid(process.pid);
		expect(readDaemonPid()).toBeUndefined();
	});

	// The service may already have started over a foreground daemon's exit.
	it("leaves a newer daemon's pid alone", () => {
		writeDaemonPid(process.pid + 1);
		releaseDaemonPid(process.pid);
		expect(readDaemonPid()).toBe(process.pid + 1);
	});
});
