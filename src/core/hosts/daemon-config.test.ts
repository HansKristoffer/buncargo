import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	daemonConfigFromFlags,
	readDaemonConfig,
	readDaemonPid,
	releaseDaemonState,
	writeDaemonConfig,
} from "./daemon-config";
import { getDaemonConfigPath, getPidfilePath } from "./paths";

let home: string;
const originalHome = process.env.HOME;
const originalPort = process.env.BUNCARGO_HOSTS_PORT;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-daemon-config-test-"));
	process.env.HOME = home;
	delete process.env.BUNCARGO_HOSTS_PORT;
});

afterEach(() => {
	process.env.HOME = originalHome;
	if (originalPort === undefined) delete process.env.BUNCARGO_HOSTS_PORT;
	else process.env.BUNCARGO_HOSTS_PORT = originalPort;
	rmSync(home, { recursive: true, force: true });
});

describe("daemon config", () => {
	// A foreground `BUNCARGO_HOSTS_PORT=8443 buncargo hosts daemon` once left
	// 8443 in the file, and the service then bound 8443 instead of :443.
	it("binds a starting daemon from its flags, not from what a previous one stored", () => {
		writeDaemonConfig({ httpsPort: 8443, httpPort: 80, tls: true });

		expect(daemonConfigFromFlags().httpsPort).toBe(443);
		process.env.BUNCARGO_HOSTS_PORT = "9443";
		expect(daemonConfigFromFlags().httpsPort).toBe(9443);
	});

	it("tells readers what the running daemon stored", () => {
		writeDaemonConfig({ httpsPort: 8443, httpPort: 80, tls: true });
		expect(readDaemonConfig().httpsPort).toBe(8443);
	});

	it("falls back to the flags when no daemon stored anything", () => {
		process.env.BUNCARGO_HOSTS_PORT = "9443";
		expect(readDaemonConfig()).toEqual({
			httpsPort: 9443,
			httpPort: 80,
			tls: true,
		});
	});
});

describe("releaseDaemonState", () => {
	// An idle exit used to leave both behind, naming a dead pid.
	it("forgets the daemon that is exiting", () => {
		writeDaemonConfig({ httpsPort: 8443, httpPort: 80, tls: true });
		writeFileSync(getPidfilePath(), `${process.pid}\n`);

		releaseDaemonState(process.pid);

		expect(readDaemonPid()).toBeUndefined();
		expect(existsSync(getDaemonConfigPath())).toBe(false);
	});

	// The service may already have started over a foreground daemon's exit.
	it("leaves a newer daemon's state alone", () => {
		writeDaemonConfig({ httpsPort: 443, httpPort: 80, tls: true });
		writeFileSync(getPidfilePath(), `${process.pid + 1}\n`);

		releaseDaemonState(process.pid);

		expect(readDaemonPid()).toBe(process.pid + 1);
		expect(existsSync(getDaemonConfigPath())).toBe(true);
	});
});
