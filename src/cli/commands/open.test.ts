import { describe, expect, it } from "bun:test";
import { CliError } from "../errors";
import { findTarget, openTargets, resolveTarget } from "./open";

it("names every URL once: apps, then captures, then labels", () => {
	const targets = openTargets(
		{
			apps: { web: {}, shopify: {}, worker: {} },
			services: {},
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
		},
		{ connectionUrls: false },
	);
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
		services: {},
		urls: { web: "https://web.app.localhost" },
		loopbackUrls: { web: "http://localhost:5173" },
		publicUrls: {},
		captured: {},
		details: () => ({}),
	};
	const browser = { connectionUrls: false };
	expect(openTargets(env, browser).web).toBe("http://localhost:5173");
	expect(openTargets({ ...env, hosts: null }, browser).web).toBe(
		"http://localhost:5173",
	);
	expect(openTargets({ ...env, hosts: { active: true } }, browser).web).toBe(
		"https://web.app.localhost",
	);
});

// `url upstash` answered "No URL named" although the run serves it.
describe("services", () => {
	const env = {
		apps: { api: {} },
		services: { upstash: {}, postgres: {}, worker: {} },
		urls: {
			api: "http://localhost:3000",
			upstash: "http://localhost:8079",
			postgres: "postgresql://postgres:postgres@localhost:5432/app",
		},
		loopbackUrls: {
			api: "http://localhost:3000",
			upstash: "http://localhost:8079",
			postgres: "postgresql://postgres:postgres@localhost:5432/app",
		},
		publicUrls: {},
		captured: {},
		details: () => ({}),
	};

	it("lists a service's URL, and its connection URL only for `url`", () => {
		expect(openTargets(env, { connectionUrls: true })).toEqual({
			api: "http://localhost:3000",
			upstash: "http://localhost:8079",
			postgres: "postgresql://postgres:postgres@localhost:5432/app",
		});
		expect(openTargets(env, { connectionUrls: false })).toEqual({
			api: "http://localhost:3000",
			upstash: "http://localhost:8079",
		});
	});

	it("says why a service has no URL, and what has one", () => {
		const targets = openTargets(env, { connectionUrls: true });
		expect(resolveTarget(env, targets, "upstash", "url")).toBe(
			"http://localhost:8079",
		);
		const refusal = (name: string, command: "url" | "open") => {
			try {
				resolveTarget(
					env,
					openTargets(env, { connectionUrls: command === "url" }),
					name,
					command,
				);
			} catch (error) {
				if (error instanceof CliError) return [error.message, ...error.hints];
			}
			throw new Error(`${name} resolved`);
		};
		expect(refusal("worker", "url")).toEqual([
			'The service "worker" has no URL: it publishes no port; `buncargo status` lists its container.',
			"Available: api, upstash, postgres",
		]);
		expect(refusal("postgres", "open")[0]).toBe(
			'The service "postgres" has no URL a browser opens; `buncargo url postgres` prints how to connect.',
		);
		expect(refusal("nope", "url")[0]).toBe('No URL named "nope".');
	});
});
