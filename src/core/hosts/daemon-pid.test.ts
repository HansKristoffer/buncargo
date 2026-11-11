import { describe, expect, it } from "bun:test";
import { useTempHome } from "../test-env.testing";
import { readDaemonPid, releaseDaemonPid, writeDaemonPid } from "./daemon-pid";

useTempHome();

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
