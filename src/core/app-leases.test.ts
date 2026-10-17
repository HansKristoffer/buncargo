import { describe, expect, it } from "bun:test";
import { describeLeaseRefusal } from "./app-leases";

describe("describeLeaseRefusal", () => {
	it("names the holder, its checkout and how long it has held the lease", () => {
		const now = new Date("2026-10-04T12:30:00Z");
		const lines = describeLeaseRefusal(
			{
				app: "shopify",
				key: "shopify-app:abc",
				holder: {
					key: "shopify-app:abc",
					sessionId: "s1",
					pid: 42,
					app: "shopify",
					projectName: "shop",
					root: "/work/shop-feature",
					worktree: "shop-feature",
					branch: "feature",
					acquiredAt: "2026-10-04T12:05:00Z",
				},
			},
			{ now },
		);
		expect(lines[0]).toBe(
			'Held by:  shop (shop-feature, feature), app "shopify", pid 42',
		);
		expect(lines[1]).toBe("Checkout: /work/shop-feature");
		expect(lines[2]).toEndWith("(25 min ago)");
	});
});
