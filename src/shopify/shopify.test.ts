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
import {
	isShopifySessionExpired,
	isTestedShopifyVersion,
	parseVersion,
	readShopifySession,
} from "./cli";
import { shopify, storeLinks } from "./index";
import { mergeLinkedConfig, setDevStoreUrl, setTopLevelKey } from "./link";
import { ensureShopifyLogin } from "./login";
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
			essential: false,
			actions: [
				{ key: "p", open: "previewUrl" },
				{ key: "g", open: "graphiqlUrl" },
			],
			startAfter: ["platform", "api", "theme"],
			exclusive: "shopify-app:0123456789abcdef0123456789abcdef",
		});
		expect(config.apps?.shopify?.interactive).toBeUndefined();
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

		const env = (config.env as () => Record<string, string>)();
		expect(env).toEqual({
			SHOPIFY_APP_CONFIG: "shopify.app.toml",
			SHOPIFY_API_KEY: "0123456789abcdef0123456789abcdef",
			SHOPIFY_DEV_STORE: "s.myshopify.com",
		});
		// The tunnel URL arrives through the capture, not the env builder.
		expect(config.apps?.shopify?.captures?.appUrl?.env).toBe("SHOPIFY_APP_URL");
		expect(
			validateConfig({
				...base,
				integrations: [shopify({ frontend: "platform" })],
			}),
		).toEqual([]);
	});
});

describe("helpers", () => {
	it("links the app in the dev store admin, and the storefront", () => {
		expect(storeLinks("https://s.myshopify.com/", "abc")).toEqual({
			"Shopify admin": "https://admin.shopify.com/store/s/apps/abc",
			"Dev store": "https://s.myshopify.com",
		});
		expect(storeLinks(undefined, "abc")).toEqual({});
	});

	it("checks the tested CLI range", () => {
		expect(isTestedShopifyVersion(parseVersion("3.93.1") as never)).toBe(true);
		expect(isTestedShopifyVersion(parseVersion("4.8.2") as never)).toBe(true);
		expect(isTestedShopifyVersion(parseVersion("3.80.0") as never)).toBe(false);
		expect(isTestedShopifyVersion(parseVersion("5.0.0") as never)).toBe(false);
	});
});

describe("Shopify session", () => {
	const store = (expiresAt: string, nested = true) =>
		JSON.stringify({
			currentSessionId: "u1",
			sessionStore: JSON.stringify({
				"accounts.shopify.com": nested
					? { u1: { identity: { userId: "u1", expiresAt } } }
					: { identity: { userId: "u1", expiresAt } },
			}),
		});

	it("reads the identity's expiry from either store layout", () => {
		const root = repo({
			"new.json": store("2026-01-01T10:00:00.000Z"),
			"old.json": store("2026-01-01T10:00:00.000Z", false),
			"none.json": JSON.stringify({ sessionStore: "{}" }),
		});
		for (const file of ["new.json", "old.json"]) {
			const session = readShopifySession(join(root, file));
			expect(session?.expiresAt?.toISOString()).toBe(
				"2026-01-01T10:00:00.000Z",
			);
			expect(
				isShopifySessionExpired(
					session as never,
					Date.parse("2026-01-01T09:00:00Z"),
				),
			).toBe(false);
			expect(
				isShopifySessionExpired(
					session as never,
					Date.parse("2026-01-01T09:59:30Z"),
				),
			).toBe(true);
		}
		expect(readShopifySession(join(root, "none.json"))).toBeUndefined();
		expect(readShopifySession(join(root, "missing.json"))).toBeUndefined();
	});

	it("fails the login preflight without a terminal instead of prompting", () => {
		const root = repo({});
		expect(() =>
			ensureShopifyLogin({
				root,
				config: "shopify.app.toml",
				linked: true,
				interactive: false,
				sessionFile: join(root, "no-session.json"),
			}),
		).toThrow(
			"not logged in to the Shopify CLI. Run `buncargo shopify login`.",
		);
		// A Partners token is how CI authenticates: nothing to check or prompt.
		expect(() =>
			ensureShopifyLogin({
				root,
				config: "shopify.app.toml",
				linked: true,
				interactive: false,
				sessionFile: join(root, "no-session.json"),
				env: { SHOPIFY_CLI_PARTNERS_TOKEN: "token" },
			}),
		).not.toThrow();
	});
});

describe("shopify link", () => {
	it("takes only client_id and name from the linked app and keeps the dev store", () => {
		const existing = TOML.replace("dev.myshopify.com", "mine.myshopify.com");
		const merged = mergeLinkedConfig({
			template: TOML,
			linked: { clientId: "f".repeat(32), name: "My dev app" },
			existing,
		});
		const config = parseShopifyAppConfig(
			merged,
			"shopify.app.local.toml",
			"local",
		);
		expect(config.clientId).toBe("f".repeat(32));
		expect(config.appName).toBe("My dev app");
		expect(config.devStoreUrl).toBe("mine.myshopify.com");
		// Everything else is the template's, untouched.
		expect(config.scopes).toEqual(["read_products", "write_products"]);
		expect(config.webhooks).toHaveLength(1);
		expect(config.appProxy?.subpath).toBe("prints");
		expect(merged.split("\n").length).toBe(TOML.split("\n").length);
	});

	it("edits commented headers and indented keys, and refuses what it cannot edit", () => {
		const linked = { clientId: "f".repeat(32), name: "Dev" };
		const commented = mergeLinkedConfig({
			template:
				'  client_id = "old"\n  name = "Old"\n\n[build] # dev settings\n  dev_store_url = "a.myshopify.com"\n',
			linked,
			existing: '[build]\ndev_store_url = "mine.myshopify.com"\n',
		});
		expect(Bun.TOML.parse(commented)).toEqual({
			client_id: "f".repeat(32),
			name: "Dev",
			build: { dev_store_url: "mine.myshopify.com" },
		});
		// A multi-line name the line edit would corrupt: refused, not written.
		expect(() =>
			mergeLinkedConfig({
				template: 'client_id = "old"\nname = """\nOld\nApp"""\n',
				linked,
			}),
		).toThrow("could not edit the toml safely");
		expect(() =>
			mergeLinkedConfig({
				template: 'client_id = "old"\nbuild.dev_store_url = "a"\n',
				linked,
				existing: '[build]\ndev_store_url = "b"\n',
			}),
		).toThrow("could not edit the toml safely");
	});

	it("adds keys and a [build] table when the template has none", () => {
		const toml = setDevStoreUrl(
			setTopLevelKey('scopes = "a"\n', "client_id", "x"),
			"s.myshopify.com",
		);
		expect(Bun.TOML.parse(toml)).toEqual({
			client_id: "x",
			scopes: "a",
			build: { dev_store_url: "s.myshopify.com" },
		});
	});
});
