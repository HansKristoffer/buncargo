import { describe, expect, it } from "bun:test";
import { CliError } from "../errors";
import { findTarget, openTargets, resolveTarget, urlOutput } from "./open";

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
		{ connectionUrls: false, urlHostSet: false },
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
	const browser = { connectionUrls: false, urlHostSet: false };
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
		expect(
			openTargets(env, { connectionUrls: true, urlHostSet: false }),
		).toEqual({
			api: "http://localhost:3000",
			upstash: "http://localhost:8079",
			postgres: "postgresql://postgres:postgres@localhost:5432/app",
		});
		expect(
			openTargets(env, { connectionUrls: false, urlHostSet: false }),
		).toEqual({
			api: "http://localhost:3000",
			upstash: "http://localhost:8079",
		});
	});

	it("says why a service has no URL, and what has one", () => {
		const targets = openTargets(env, {
			connectionUrls: true,
			urlHostSet: false,
		});
		expect(resolveTarget(env, targets, "upstash", "url")).toBe(
			"http://localhost:8079",
		);
		const refusal = (name: string, command: "url" | "open") => {
			try {
				resolveTarget(
					env,
					openTargets(env, {
						connectionUrls: command === "url",
						urlHostSet: false,
					}),
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

// With BUNCARGO_URL_HOST every app URL is plain HTTP on a remote host, where a
// browser gives the page no secure context (crypto.randomUUID, the clipboard).
describe("url with BUNCARGO_URL_HOST", () => {
	const env = {
		apps: { api: {} },
		services: { postgres: {} },
		urls: {
			api: "http://worker.ts.net:3000",
			postgres: "postgresql://postgres:postgres@localhost:5432/app",
		},
		loopbackUrls: { api: "http://localhost:3000" },
		publicUrls: {},
		captured: {},
		details: () => ({}),
	};
	const urlHost = "worker.ts.net";

	it("prints the remote URL for the person, with a warning that names --local", () => {
		const output = urlOutput(env, { name: "api", local: false }, urlHost);
		expect(output.lines).toEqual(["http://worker.ts.net:3000"]);
		expect(output.warning).toContain("`buncargo url api --local`");
	});

	it("prints loopback with --local, and nothing to warn about", () => {
		expect(urlOutput(env, { name: "api", local: true }, urlHost)).toEqual({
			lines: ["http://localhost:3000"],
			warning: undefined,
		});
		expect(urlOutput(env, { name: undefined, local: true }, urlHost)).toEqual({
			lines: [
				"api       http://localhost:3000",
				"postgres  postgresql://postgres:postgres@localhost:5432/app",
			],
			warning: undefined,
		});
	});

	it("does not warn about an https named host", () => {
		const named = {
			...env,
			hosts: { active: true },
			urls: { ...env.urls, api: "https://api.app.localhost" },
		};
		expect(
			urlOutput(named, { name: "api", local: false }, urlHost).warning,
		).toBeUndefined();
	});
});
