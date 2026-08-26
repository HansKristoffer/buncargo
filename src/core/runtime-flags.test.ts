import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cloudflaredPathOverride,
	cloudflaredVersion,
	exposeTunnelStaggerMs,
	hostsDaemonPort,
	isCI,
	isHostsForcedOff,
	mkcertPathOverride,
	mkcertVersion,
	portOffsetOverride,
	quickTunnelMaxAttempts,
	quickTunnelRetryBaseMs,
	quickTunnelUrlTimeoutMs,
	shouldSyncHostsFile,
} from "./runtime-flags";

describe("isCI", () => {
	it("detects the supported providers", () => {
		expect(isCI({ CI: "true" })).toBe(true);
		expect(isCI({ CI: "1" })).toBe(true);
		expect(isCI({ GITHUB_ACTIONS: "true" })).toBe(true);
		expect(isCI({ GITLAB_CI: "true" })).toBe(true);
		expect(isCI({ CIRCLECI: "true" })).toBe(true);
		expect(isCI({ JENKINS_URL: "http://jenkins.example.com" })).toBe(true);
	});

	it("is false outside CI", () => {
		expect(isCI({})).toBe(false);
		expect(isCI({ CI: "false" })).toBe(false);
		expect(isCI({ CI: "" })).toBe(false);
	});
});

describe("portOffsetOverride", () => {
	it("reads BUNCARGO_PORT_OFFSET", () => {
		expect(portOffsetOverride({ BUNCARGO_PORT_OFFSET: "400" })).toBe(400);
		expect(portOffsetOverride({})).toBeUndefined();
	});

	it("rejects invalid values", () => {
		expect(() => portOffsetOverride({ BUNCARGO_PORT_OFFSET: "nope" })).toThrow(
			/BUNCARGO_PORT_OFFSET/,
		);
		expect(() => portOffsetOverride({ BUNCARGO_PORT_OFFSET: "20000" })).toThrow(
			/BUNCARGO_PORT_OFFSET/,
		);
	});
});

describe("isHostsForcedOff", () => {
	it("is on unless CI or BUNCARGO_HOSTS=0", () => {
		expect(isHostsForcedOff({})).toBe(false);
		expect(isHostsForcedOff({ BUNCARGO_HOSTS: "0" })).toBe(true);
		expect(isHostsForcedOff({ CI: "1" })).toBe(true);
		expect(isHostsForcedOff({ CI: "true" })).toBe(true);
	});

	it("stays off in CI providers that do not set CI", () => {
		expect(isHostsForcedOff({ GITLAB_CI: "true" })).toBe(true);
		expect(isHostsForcedOff({ GITHUB_ACTIONS: "true" })).toBe(true);
	});
});

describe("hostsDaemonPort", () => {
	it("defaults to 443 and falls back on garbage", () => {
		expect(hostsDaemonPort({})).toBe(443);
		expect(hostsDaemonPort({ BUNCARGO_HOSTS_PORT: "8443" })).toBe(8443);
		expect(hostsDaemonPort({ BUNCARGO_HOSTS_PORT: "nope" })).toBe(443);
		expect(hostsDaemonPort({ BUNCARGO_HOSTS_PORT: "0" })).toBe(443);
	});
});

describe("shouldSyncHostsFile", () => {
	it("is on unless BUNCARGO_SYNC_HOSTS=0", () => {
		expect(shouldSyncHostsFile({})).toBe(true);
		expect(shouldSyncHostsFile({ BUNCARGO_SYNC_HOSTS: "0" })).toBe(false);
	});
});

describe("tool binary overrides", () => {
	it("returns the override when it exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-flags-"));
		const bin = join(dir, "tool");
		writeFileSync(bin, "");

		expect(mkcertPathOverride({ BUNCARGO_MKCERT_PATH: bin })).toBe(bin);
		expect(cloudflaredPathOverride({ BUNCARGO_CLOUDFLARED_PATH: bin })).toBe(
			bin,
		);
	});

	it("throws when the override points nowhere", () => {
		expect(() =>
			mkcertPathOverride({ BUNCARGO_MKCERT_PATH: "/nope/mkcert" }),
		).toThrow(/BUNCARGO_MKCERT_PATH/);
		expect(() =>
			cloudflaredPathOverride({ BUNCARGO_CLOUDFLARED_PATH: "/nope/cf" }),
		).toThrow(/BUNCARGO_CLOUDFLARED_PATH/);
	});

	it("is undefined when unset", () => {
		expect(mkcertPathOverride({})).toBeUndefined();
		expect(cloudflaredPathOverride({})).toBeUndefined();
	});
});

describe("tool versions", () => {
	it("are read per call so a flag set mid-run still applies", () => {
		expect(mkcertVersion({})).toBe("v1.4.4");
		expect(mkcertVersion({ BUNCARGO_MKCERT_VERSION: "v1.5.0" })).toBe("v1.5.0");
		expect(cloudflaredVersion({ CLOUDFLARED_VERSION: "latest" })).toBe(
			"latest",
		);
	});
});

describe("tunnel timings", () => {
	it("default and parse", () => {
		expect(exposeTunnelStaggerMs({})).toBe(900);
		expect(
			exposeTunnelStaggerMs({ BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS: "0" }),
		).toBe(0);
		expect(quickTunnelMaxAttempts({})).toBe(5);
		expect(
			quickTunnelMaxAttempts({ BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS: "0" }),
		).toBe(5);
		expect(
			quickTunnelMaxAttempts({ BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS: "2" }),
		).toBe(2);
		expect(quickTunnelRetryBaseMs({})).toBe(2000);
		expect(
			quickTunnelRetryBaseMs({ BUNCARGO_QUICK_TUNNEL_RETRY_BASE_MS: "500" }),
		).toBe(500);
		expect(quickTunnelUrlTimeoutMs({})).toBe(30_000);
		expect(
			quickTunnelUrlTimeoutMs({ BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS: "5000" }),
		).toBe(5000);
		expect(
			quickTunnelUrlTimeoutMs({ BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS: "0" }),
		).toBe(0);
	});
});
