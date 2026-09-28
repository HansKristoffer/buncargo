import * as log from "../cli/log";
import type { IntegrationCommand } from "../types";
import { readShopifyAppConfig } from "./app-config";

/**
 * `buncargo shopify <command>`. The app, preview and GraphiQL URLs are
 * labelled captures and the admin/store links are `describe` rows, so
 * `buncargo url` and `buncargo open` reach them like any other.
 */
export function shopifyCommands(state: {
	config: string;
}): Record<string, IntegrationCommand> {
	return {
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
