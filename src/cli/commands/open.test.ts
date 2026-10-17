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

// The TUI's `o` makes the same call: a run with no named hosts serving opens
// loopback, never a named URL that nothing answers.
it("opens loopback when nothing says named hosts are serving", () => {
	const env = {
		apps: { web: {} },
		urls: { web: "https://web.app.localhost" },
		loopbackUrls: { web: "http://localhost:5173" },
		publicUrls: {},
		captured: {},
		details: () => ({}),
	};
	expect(openTargets(env).web).toBe("http://localhost:5173");
	expect(openTargets({ ...env, hosts: null }).web).toBe(
		"http://localhost:5173",
	);
	expect(openTargets({ ...env, hosts: { active: true } }).web).toBe(
		"https://web.app.localhost",
	);
});
