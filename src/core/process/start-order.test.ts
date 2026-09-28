import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../../types";
import { planSpawnOrder } from "./start-order";

const worker = (extra: Partial<AppConfig> = {}): AppConfig =>
	({ kind: "worker", devCommand: "x", ...extra }) as AppConfig;
const names = (layers: Record<string, AppConfig>[]) =>
	layers.map((layer) => Object.keys(layer));

describe("planSpawnOrder", () => {
	it("is one layer without startAfter, as the old wave was", () => {
		const order = planSpawnOrder({ a: worker(), b: worker() }, true);
		expect(names(order.beforeTunnels)).toEqual([["a", "b"]]);
		expect(order.afterTunnels).toEqual([]);
	});

	it("layers apps by startAfter", () => {
		const order = planSpawnOrder(
			{
				shopify: worker({ startAfter: ["platform", "api"] }),
				platform: worker({ startAfter: ["api"] }),
				api: worker(),
				ext: worker(),
			},
			false,
		);
		expect(names(order.beforeTunnels)).toEqual([
			["api", "ext"],
			["platform"],
			["shopify"],
		]);
	});

	// A dependency outside the start set is already up (reused, or not selected).
	it("treats a dependency outside the set as satisfied", () => {
		const order = planSpawnOrder(
			{ web: worker({ startAfter: ["api"] }) },
			false,
		);
		expect(names(order.beforeTunnels)).toEqual([["web"]]);
	});

	it("puts apps that start after a public-URL app behind the tunnels", () => {
		const order = planSpawnOrder(
			{
				api: worker(),
				hooks: worker({ needsPublicUrls: true }),
				after: worker({ startAfter: ["hooks"] }),
			},
			true,
		);
		expect(names(order.beforeTunnels)).toEqual([["api"]]);
		expect(names(order.afterTunnels)).toEqual([["hooks"], ["after"]]);
	});

	it("ignores needsPublicUrls when nothing is deferred", () => {
		const order = planSpawnOrder(
			{ hooks: worker({ needsPublicUrls: true }) },
			false,
		);
		expect(names(order.beforeTunnels)).toEqual([["hooks"]]);
	});

	it("fails loudly on a cycle validation should have caught", () => {
		expect(() =>
			planSpawnOrder(
				{ a: worker({ startAfter: ["b"] }), b: worker({ startAfter: ["a"] }) },
				false,
			),
		).toThrow("Circular startAfter");
	});
});
