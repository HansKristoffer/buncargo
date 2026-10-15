import { describe, expect, it } from "bun:test";
import type { RunEntry } from "./run-registry";
import { serveTailnetDirectory } from "./tailnet-directory";
import { tailscaleAddress } from "./tailscale";

function iface(address: string, family: "IPv4" | "IPv6" = "IPv4") {
	return {
		address,
		family,
		netmask: "",
		mac: "",
		internal: false,
		cidr: null,
	} as never;
}

describe("tailscaleAddress", () => {
	it("finds the tailnet IPv4 on Tailscale's interface", () => {
		expect(
			tailscaleAddress({
				en0: [iface("192.168.1.4")],
				utun4: [iface("fd7a:115c:a1e0::1", "IPv6"), iface("100.101.2.3")],
			}),
		).toBe("100.101.2.3");
		expect(tailscaleAddress({ tailscale0: [iface("100.64.0.9")] })).toBe(
			"100.64.0.9",
		);
	});

	it("ignores the carrier-grade NAT range on other interfaces", () => {
		// A phone hotspot can hand en0 an address in 100.64.0.0/10.
		expect(tailscaleAddress({ en0: [iface("100.80.1.2")] })).toBeUndefined();
		expect(tailscaleAddress({ utun2: [iface("100.128.0.1")] })).toBeUndefined();
	});
});

describe("serveTailnetDirectory", () => {
	it("serves live runs as a runs.json document on the tailnet address", async () => {
		const run = { sessionId: "s1", projectName: "web" } as RunEntry;
		let url = "";
		let stopServing = () => {};
		const listening = new Promise<void>((resolve) => {
			const stop = serveTailnetDirectory({
				port: 0,
				intervalMs: 60_000,
				address: () => "127.0.0.1",
				readRuns: async () => [run],
				log: (message) => {
					url = message.replace("Tailnet directory on ", "");
					resolve();
				},
			});
			stopServing = stop;
		});
		await listening;

		try {
			const response = await fetch(url);
			expect(await response.json()).toEqual({ version: 1, runs: [run] });
			expect((await fetch(url.replace("/v1/runs", "/"))).status).toBe(404);
		} finally {
			stopServing();
		}
	});

	it("serves nothing without a tailnet address", () => {
		const logs: string[] = [];
		const stop = serveTailnetDirectory({
			intervalMs: 60_000,
			address: () => undefined,
			log: (message) => logs.push(message),
		});
		stop();
		expect(logs).toEqual([]);
	});
});
