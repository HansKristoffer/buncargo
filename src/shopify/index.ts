import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
	type DiscoverAppsOptions,
	discoverApps,
} from "../config/discover-apps";
import { mergeConfigs } from "../config/merge-configs";
import { buncargoCli } from "../core/cli-entry";
import { findMonorepoRoot } from "../core/ports";
import { shellQuote } from "../core/shell-quote";
import type {
	AppConfig,
	BuncargoIntegration,
	CaptureConfig,
	GeneratedFileContext,
	IntegrationConfig,
} from "../types";
import {
	readShopifyAppConfig,
	type ShopifyAppConfig,
	shopifyConfigFile,
	shopifyConfigName,
} from "./app-config";
import { isClientId, shopifyChecks } from "./checks";
import { resolveShopifyBin } from "./cli";
import { shopifyCommands } from "./commands";
import { ensureShopifyLogin } from "./login";
import { renderShopifyWebToml, SHOPIFY_WEB_DIR } from "./web";

/**
 * `buncargo/shopify`: `shopify app dev` inside the run.
 *
 * ```ts
 * import { shopify } from "buncargo/shopify";
 * integrations: [shopify({ config: "shopify.app.toml", frontend: "platform", backend: "api" })]
 * ```
 *
 * buncargo owns Postgres, Redis, the API, Vite and every watcher; Shopify CLI
 * owns the tunnel, the extension dev server and the admin preview. The
 * tunnel reaches buncargo's Vite through the CLI's proxy and a generated
 * `shopify.web.toml` that starts nothing (see `./web.ts`).
 */

export {
	listShopifyAppConfigs,
	parseShopifyAppConfig,
	readShopifyAppConfig,
	type ShopifyAppConfig,
	type ShopifyWebhookSubscription,
} from "./app-config";
export { patchWebDirectories, SHOPIFY_WEB_DIR } from "./web";

declare module "../types/all-types" {
	interface IntegrationAppNames {
		shopify: true;
	}
}

export interface ShopifyIntegrationOptions {
	/** Which app toml: `shopify.app.toml` (default), a name, or `shopify.app.<name>.toml`. */
	config?: string;
	/** The app serving the embedded admin UI; the tunnel is proxied to it. */
	frontend?: string;
	/** The API the frontend proxies to; the CLI starts only once it is healthy too. */
	backend?: string;
	/** Dev store, overriding the toml's `dev_store_url` (`--store`). */
	store?: string;
	/**
	 * Extension workspaces (`discoverApps` options), started as watchers after
	 * their `build` has run once. Default: `apps/extension-*` and `extensions/*`
	 * with `dev`, prebuilt with `build`. `false` discovers nothing.
	 */
	extensions?: Partial<DiscoverAppsOptions> | false;
	/** Hold an exclusive lease on the dev app, so worktrees don't fight over it. Default: true */
	lease?: boolean;
	/**
	 * Touch theme extension assets once the CLI is ready: it often skips the
	 * first dev-preview push until a later file change. Default: true
	 */
	nudgeThemeAssets?: boolean;
}

/** Output Shopify CLI prints that the run cares about. */
export const SHOPIFY_CAPTURES: Record<string, CaptureConfig> = {
	// Box-drawing and `|` separate Ink columns; neither is part of the URL.
	appUrl: {
		pattern: /Using URL:\s*(https?:\/\/[^\s│|)]+)/,
		as: "publicUrl",
		label: "Shopify app URL",
		env: "SHOPIFY_APP_URL",
	},
	// 4.x prints "GraphiQL URL (Admin API):" when not drawing its TUI.
	graphiqlUrl: {
		pattern: /GraphiQL URL(?: \(Admin API\))?:\s*(https?:\/\/[^\s│|)]+)/,
		as: "value",
		label: "GraphiQL",
	},
	/** The embedded app in the dev store's admin; opening it installs the app. */
	previewUrl: {
		pattern: /Preview URL:\s*(https?:\/\/[^\s│|)]+)/,
		as: "value",
		label: "Shopify preview",
	},
	shopifyReady: {
		pattern: /Ready, watching for changes in your app/,
		as: "event",
	},
};

function touchTree(dir: string, when: Date): number {
	let touched = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) touched += touchTree(path, when);
		else {
			utimesSync(path, when, when);
			touched++;
		}
	}
	return touched;
}

/** Bump every `extensions/*\/assets` file, once, so the CLI pushes them. */
function nudgeThemeAssets(root: string): number {
	const extensions = join(root, "extensions");
	if (!existsSync(extensions)) return 0;
	const now = new Date();
	let touched = 0;
	for (const name of readdirSync(extensions)) {
		const assets = join(extensions, name, "assets");
		if (existsSync(assets) && statSync(assets).isDirectory()) {
			touched += touchTree(assets, now);
		}
	}
	return touched;
}

/** The app in the dev store's admin, and the storefront. */
export function storeLinks(
	store: string | undefined,
	clientId: string | undefined,
): Record<string, string> {
	const domain = store?.replace(/^https?:\/\//, "").replace(/\/$/, "");
	if (!domain) return {};
	const handle = domain.replace(/\.myshopify\.com$/, "");
	return {
		...(clientId
			? {
					"Shopify admin": `https://admin.shopify.com/store/${handle}/apps/${clientId}`,
				}
			: {}),
		"Dev store": `https://${domain}`,
	};
}

export function shopify(
	options: ShopifyIntegrationOptions = {},
): BuncargoIntegration {
	const file = shopifyConfigFile(options.config);
	const configName = shopifyConfigName(file);
	const state = { config: configName };
	// Read in `config()`, which runs in the process `describe` does.
	let appToml: ShopifyAppConfig | undefined;
	let nudged = false;

	return {
		name: "shopify",

		config(config) {
			const root = findMonorepoRoot();
			const apps = config.apps ?? {};
			// Lenient: without the toml (CI, a fresh clone) the app still gets a
			// dev command, and `setup` / `doctor` report what is missing.
			appToml = (() => {
				try {
					return readShopifyAppConfig(file, root);
				} catch {
					return undefined;
				}
			})();

			const frontend = options.frontend;
			for (const name of [frontend, options.backend]) {
				if (name && !apps[name]) {
					throw new Error(`shopify(): "${name}" is not a configured app`);
				}
			}

			const extensions =
				options.extensions === false
					? {}
					: discoverApps({
							globs: ["apps/extension-*", "extensions/*"],
							script: "dev",
							prebuild: "build",
							...options.extensions,
							root,
						});
			// An app the config defines itself wins over a discovered one.
			const discovered = Object.fromEntries(
				Object.entries(extensions).filter(([name]) => !apps[name]),
			);

			const store = options.store;
			const devCommand = [
				shellQuote(resolveShopifyBin(root)),
				"app",
				"dev",
				"--config",
				shellQuote(configName),
				...(store ? ["--store", shellQuote(store)] : []),
			].join(" ");

			// No `interactive`: in the TUI it has a terminal (and pane) of its
			// own; in stream mode piped output makes it print plain lines, which
			// the captures read. Not `CI=1` to force that: it also turns off the
			// device-code login. And not essential: an extension build error or a
			// lost session stops this app, not the API and the frontend with it.
			const shopifyApp: AppConfig = {
				kind: "worker",
				devCommand,
				essential: false,
				actions: [
					{ key: "p", label: "preview", open: "previewUrl" },
					{ key: "g", label: "GraphiQL", open: "graphiqlUrl" },
				],
				startAfter: [
					...(frontend ? [frontend] : []),
					...(options.backend ? [options.backend] : []),
					...Object.keys(discovered),
				],
				captures: SHOPIFY_CAPTURES,
				...(options.lease !== false && appToml
					? { exclusive: `shopify-app:${appToml.clientId}` }
					: {}),
			};

			const cli = buncargoCli();
			return mergeConfigs(config, {
				apps: { ...apps, ...discovered, shopify: shopifyApp },
				// The admin UI is what "Open" should open, not the CLI's worker.
				...(frontend && !config.options?.primaryApp
					? { options: { primaryApp: frontend } }
					: {}),
				env: () => {
					const devStore = store ?? appToml?.devStoreUrl;
					return {
						SHOPIFY_APP_CONFIG: configName,
						...(appToml ? { SHOPIFY_API_KEY: appToml.clientId } : {}),
						...(devStore ? { SHOPIFY_DEV_STORE: devStore } : {}),
					};
				},
				generatedFiles: [
					...(config.generatedFiles ?? []),
					...(frontend
						? [
								{
									path: `${SHOPIFY_WEB_DIR}/shopify.web.toml`,
									render: ({ ports }: GeneratedFileContext) =>
										renderShopifyWebToml({
											frontend,
											port: ports[frontend],
											buncargo: cli.script
												? [cli.program, cli.script]
												: [cli.program],
										}),
								},
							]
						: []),
				],
			}) as IntegrationConfig;
		},

		hooks: {
			onCapture: (event, ctx) => {
				if (
					event.name !== "shopifyReady" ||
					options.nudgeThemeAssets === false ||
					nudged
				) {
					return;
				}
				nudged = true;
				const touched = nudgeThemeAssets(ctx.root);
				if (touched > 0) {
					console.log(
						`  Touched ${touched} theme extension asset(s) to refresh the dev preview`,
					);
				}
			},
		},

		checks: shopifyChecks(state),
		commands: shopifyCommands(state),
		preflight: [
			{
				name: "Shopify CLI session is valid",
				apps: ["shopify"],
				run: ({ root, interactive }) =>
					ensureShopifyLogin({
						root,
						config: configName,
						linked: appToml !== undefined && isClientId(appToml.clientId),
						interactive,
					}),
			},
		],

		// The captured URLs label themselves; these are the ones the toml gives.
		describe: () =>
			storeLinks(options.store ?? appToml?.devStoreUrl, appToml?.clientId),
	};
}
