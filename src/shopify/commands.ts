import * as log from "../cli/log";
import { adoptLiveCaptures } from "../cli/run-publish";
import { openUrl } from "../core/open-url";
import type { AnyDevEnvironment, IntegrationCommand } from "../types";
import { readShopifyAppConfig } from "./app-config";

interface ShopifyCommandState {
	config: string;
	store?: string;
}

function storeDomain(
	env: AnyDevEnvironment,
	state: ShopifyCommandState,
): string | undefined {
	const store =
		state.store ?? readShopifyAppConfig(state.config, env.root).devStoreUrl;
	return store?.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function shopifyCommands(
	state: ShopifyCommandState,
): Record<string, IntegrationCommand> {
	return {
		url: {
			summary: "Print this checkout's Shopify app URL",
			run: async ({ loadEnv }) => {
				const url = (await adoptLiveCaptures(await loadEnv())).appUrl;
				if (!url) {
					log.error(
						"No app URL yet: is `buncargo dev` running the shopify app?",
					);
					return 1;
				}
				log.line(url);
				return 0;
			},
		},

		open: {
			summary:
				"Open the app in the dev store admin, the storefront, or GraphiQL",
			usage: "open [admin|store|graphiql]",
			run: async ({ args, loadEnv }) => {
				const env = await loadEnv();
				const target = args[0] ?? "admin";
				const store = storeDomain(env, state);
				const { clientId } = readShopifyAppConfig(state.config, env.root);
				const captured = await adoptLiveCaptures(env);
				let url: string | undefined;
				if (target === "admin" && captured.previewUrl) {
					// The CLI's own preview link installs and opens the app.
					url = captured.previewUrl;
				} else if (target === "admin" && store) {
					url = `https://admin.shopify.com/store/${store.replace(/\.myshopify\.com$/, "")}/apps/${clientId}`;
				} else if (target === "store" && store) {
					url = `https://${store}`;
				} else if (target === "graphiql") {
					url = captured.graphiqlUrl;
				} else if (!["admin", "store", "graphiql"].includes(target)) {
					log.error(
						`Unknown target "${target}": use admin, store or graphiql.`,
					);
					return 1;
				}
				if (!url) {
					log.error(
						target === "graphiql"
							? "No GraphiQL URL yet: Shopify CLI prints it once `app dev` is up."
							: "No dev store: set `store` in shopify() or dev_store_url in the toml.",
					);
					return 1;
				}
				log.info(`Opening ${url}`);
				openUrl(url);
				return 0;
			},
		},

		env: {
			summary: "Print the app toml as JSON (client_id, scopes, URLs)",
			usage: "env [--config=<name>]",
			run: async ({ args, root }) => {
				const name =
					args
						.find((arg) => arg.startsWith("--config="))
						?.slice("--config=".length) ?? state.config;
				const { raw: _raw, ...config } = readShopifyAppConfig(name, root);
				log.line(JSON.stringify(config, null, 2));
				return 0;
			},
		},
	};
}
