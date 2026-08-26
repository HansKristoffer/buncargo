import { describe, expect, it } from "bun:test";
import { parseQuickTunnelUrlFromOutput } from "./cloudflared-process";

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
