import { expect, it } from "bun:test";
import { findTarget, openTargets } from "./open";

it("names every URL once: apps, then captures, then labels", () => {
	const targets = openTargets({
		apps: { web: {}, shopify: {}, worker: {} },
		urls: { web: "https://web.localhost" },
		publicUrls: { shopify: "https://abc.trycloudflare.com" },
		captured: {
			appUrl: "https://abc.trycloudflare.com",
			previewUrl: "https://s.myshopify.com/admin/oauth",
			secret: "whsec_1",
		},
		details: () => ({
			"Shopify preview": "https://s.myshopify.com/admin/oauth",
			"Shopify admin": "https://admin.shopify.com/store/s/apps/abc",
		}),
	});
	expect(targets).toEqual({
		web: "https://web.localhost",
		shopify: "https://abc.trycloudflare.com",
		previewUrl: "https://s.myshopify.com/admin/oauth",
		"Shopify admin": "https://admin.shopify.com/store/s/apps/abc",
	});
	expect(findTarget(targets, "shopify admin")).toBe(
		"https://admin.shopify.com/store/s/apps/abc",
	);
	expect(findTarget(targets, "nope")).toBeUndefined();
});
