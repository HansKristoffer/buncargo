import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	parseQuickTunnelUrlFromOutput,
	resolveQuickTunnelUrlTimeoutMs,
} from "./cloudflared-process";

const TIMEOUT_ENV = "BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS";

describe("resolveQuickTunnelUrlTimeoutMs", () => {
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env[TIMEOUT_ENV];
	});

	afterEach(() => {
		if (prev === undefined) {
			delete process.env[TIMEOUT_ENV];
		} else {
			process.env[TIMEOUT_ENV] = prev;
		}
	});

	it("defaults to 30000 when unset", () => {
		delete process.env[TIMEOUT_ENV];
		expect(resolveQuickTunnelUrlTimeoutMs()).toBe(30_000);
	});

	it("parses a positive integer", () => {
		process.env[TIMEOUT_ENV] = "5000";
		expect(resolveQuickTunnelUrlTimeoutMs()).toBe(5000);
	});

	it("allows 0 to disable timeout", () => {
		process.env[TIMEOUT_ENV] = "0";
		expect(resolveQuickTunnelUrlTimeoutMs()).toBe(0);
	});
});

describe("parseQuickTunnelUrlFromOutput", () => {
	it("parses URL from ASCII box pipe line", () => {
		const log = `
2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+
2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
2024-01-01T00:00:00Z INF |  https://foo-bar-baz.trycloudflare.com                                                    |
2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+
`;
		expect(parseQuickTunnelUrlFromOutput(log)).toBe(
			"https://foo-bar-baz.trycloudflare.com",
		);
	});

	it("parses trycloudflare URL without relying on the pipe prefix", () => {
		const log = `some noise https://x.trycloudflare.com/path more`;
		expect(parseQuickTunnelUrlFromOutput(log)).toBe(
			"https://x.trycloudflare.com",
		);
	});
});
