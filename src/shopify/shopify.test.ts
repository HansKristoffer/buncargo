import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../cli/checks";
import { validateConfig } from "../config";
import type { AnyDevEnvironment, IntegrationConfig } from "../types";
import {
	parseShopifyAppConfig,
	shopifyConfigFile,
	shopifyConfigName,
} from "./app-config";
import { shopifyChecks } from "./checks";
import { isTestedShopifyVersion, parseVersion } from "./cli";
import { shopify } from "./index";
import { patchWebDirectories, renderShopifyWebToml } from "./web";

const roots: string[] = [];
const cwd = process.cwd();
afterEach(() => {
	process.chdir(cwd);
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const TOML = `client_id = "0123456789abcdef0123456789abcdef"
name = "shop"
application_url = "https://example.com"
# the key the integration needs
web_directories = []

[build]
automatically_update_urls_on_dev = true
dev_store_url = "dev.myshopify.com"

[webhooks]
api_version = "2026-01"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/api/webhooks"

[access_scopes]
scopes = "read_products, write_products"

[app_proxy]
url = "/api/rpc"
prefix = "apps"
subpath = "prints"
`;

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "buncargo-shopify-"));
	roots.push(root);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ workspaces: ["extensions/*"] }),
	);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

describe("app toml", () => {
	it("reads what app code needs", () => {
		const config = parseShopifyAppConfig(
			TOML,
			"/x/shopify.app.toml",
			"shopify.app.toml",
		);
		expect(config).toMatchObject({
			clientId: "0123456789abcdef0123456789abcdef",
			scopes: ["read_products", "write_products"],
			apiVersion: "2026-01",
			appProxy: { url: "/api/rpc", prefix: "apps", subpath: "prints" },
			devStoreUrl: "dev.myshopify.com",
			automaticallyUpdateUrlsOnDev: true,
			webDirectories: [],
		});
	});

	it("maps config names the way --config does", () => {
		expect(shopifyConfigFile()).toBe("shopify.app.toml");
		expect(shopifyConfigFile("prod")).toBe("shopify.app.prod.toml");
		expect(shopifyConfigName("shopify.app.prod.toml")).toBe("prod");
		expect(shopifyConfigName("shopify.app.toml")).toBe("shopify.app.toml");
	});
});

describe("web toml", () => {
	it("renders one frontend web on the buncargo port that only waits", () => {
		expect(
			renderShopifyWebToml({
				frontend: "platform",
				port: 5190,
				buncargo: [
					"/usr/bin/bun",
					"/repo/node_modules/buncargo/dist/cli/bin.js",
				],
			}),
		).toContain(
			'port = 5190\n\n[commands]\ndev = "/usr/bin/bun /repo/node_modules/buncargo/dist/cli/bin.js wait --app=platform --hold --timeout=0"',
		);
	});

	it("patches web_directories in place, keeping comments", () => {
		const patched = patchWebDirectories(TOML);
		expect(patched).toContain(
			'# the key the integration needs\nweb_directories = [".buncargo/shopify/web"]',
		);
		expect(patched.match(/web_directories/g)).toHaveLength(1);
	});

	it("inserts web_directories before the first table", () => {
		const patched = patchWebDirectories(
			'client_id = "x"\n\n[build]\nfoo = 1\n',
		);
		expect(patched).toBe(
			'client_id = "x"\n\nweb_directories = [".buncargo/shopify/web"]\n\n[build]\nfoo = 1\n',
		);
		expect(Bun.TOML.parse(patched)).toMatchObject({
			web_directories: [".buncargo/shopify/web"],
		});
	});
});

describe("shopify checks", () => {
	it("flags an empty web_directories and fixes it", async () => {
		const root = repo({ "shopify.app.toml": TOML });
		const [check] = shopifyChecks({ config: "shopify.app.toml" }).filter(
			(entry) => entry.name.includes("web_directories"),
		);
		const ctx = { root, env: {} as AnyDevEnvironment };
		const [before] = await runChecks([check as never], ctx);
		expect(before).toMatchObject({
			ok: false,
			detail: expect.stringContaining("every shopify.web.toml"),
		});
		expect(check?.fast).not.toBe(false);
		await (check?.fix as (c: typeof ctx) => void)(ctx);
		const [after] = await runChecks([check as never], ctx);
		expect(after?.ok).toBe(true);
	});

	it("warns when app configs or extensions disagree", async () => {
		const root = repo({
			"shopify.app.toml": TOML,
			"shopify.app.prod.toml": TOML.replace("write_products", "write_orders")
				.replace('"2026-01"', '"2025-10"')
				.replace('url = "/api/rpc"', 'url = "https://prod.example/api/rpc"'),
			"extensions/theme/shopify.extension.toml": 'api_version = "2026-01"\n',
		});
		// Only the file checks: the rest spawn the real CLI.
		const checks = shopifyChecks({ config: "shopify.app.toml" }).filter(
			(check) => /agree/.test(check.name),
		);
		const results = await runChecks(checks, {
			root,
			env: {} as AnyDevEnvironment,
		});
		const byName = Object.fromEntries(
			results.map((result) => [result.check.name, result]),
		);

		expect(byName["Shopify API versions agree"]?.ok).toBe(false);
		const agree =
			byName["Shopify app configs agree on scopes, webhooks and app proxy"];
		expect(agree?.ok).toBe(false);
		// Scopes differ; the app proxy's path is the same on both hosts.
		expect(agree?.detail).toContain(
			"prod vs shopify.app.toml: scope write_orders only in the first",
		);
		expect(agree?.detail).not.toContain("app_proxy");
	});
});

describe("shopify()", () => {
	it("adds the CLI app, extension watchers, env and the web toml", () => {
		const root = repo({
			"shopify.app.toml": TOML,
			"extensions/theme/package.json": JSON.stringify({
				scripts: { dev: "x", build: "y" },
			}),
		});
		process.chdir(root);
		const base: IntegrationConfig = {
			projectPrefix: "shop",
			services: {},
			apps: {
				api: { port: 3000, devCommand: "bun dev" },
				platform: { port: 5173, devCommand: "bun dev" },
			},
		};
		const config = shopify({
			frontend: "platform",
			backend: "api",
			store: "s.myshopify.com",
		}).config?.(base) as IntegrationConfig;

		expect(config.apps?.shopify).toMatchObject({
			kind: "worker",
			interactive: true,
			startAfter: ["platform", "api", "theme"],
			exclusive: "shopify-app:0123456789abcdef0123456789abcdef",
		});
		expect(config.apps?.shopify?.devCommand).toEndWith(
			"app dev --config shopify.app.toml --store s.myshopify.com",
		);
		expect(config.apps?.theme).toMatchObject({
			kind: "worker",
			prebuild: "bun run build",
		});
		expect(config.generatedFiles?.map((file) => file.path)).toEqual([
			".buncargo/shopify/web/shopify.web.toml",
		]);
		expect(config.options?.primaryApp).toBe("platform");

		const env = (config.env as (...args: unknown[]) => Record<string, string>)(
			{},
			{},
			{
				publicUrls: {},
				captured: { appUrl: "https://abc.trycloudflare.com" },
			},
		);
		expect(env).toEqual({
			SHOPIFY_APP_CONFIG: "shopify.app.toml",
			SHOPIFY_API_KEY: "0123456789abcdef0123456789abcdef",
			SHOPIFY_APP_URL: "https://abc.trycloudflare.com",
			SHOPIFY_DEV_STORE: "s.myshopify.com",
		});
		expect(
			validateConfig({
				...base,
				integrations: [shopify({ frontend: "platform" })],
			}),
		).toEqual([]);
	});
});

describe("helpers", () => {
	it("checks the tested CLI range", () => {
		expect(isTestedShopifyVersion(parseVersion("3.93.1") as never)).toBe(true);
		expect(isTestedShopifyVersion(parseVersion("4.8.2") as never)).toBe(true);
		expect(isTestedShopifyVersion(parseVersion("3.80.0") as never)).toBe(false);
		expect(isTestedShopifyVersion(parseVersion("5.0.0") as never)).toBe(false);
	});
});
