import * as log from "../cli/log";
import type { IntegrationCommand } from "../types";
import { readShopifyAppConfig } from "./app-config";
import { shopifyLogin } from "./cli";
import { describeChange, linkShopifyApp } from "./link";

/**
 * `buncargo shopify <command>`. The app, preview and GraphiQL URLs are
 * labelled captures and the admin/store links are `describe` rows, so
 * `buncargo url` and `buncargo open` reach them like any other.
 */
export function shopifyCommands(state: {
	config: string;
}): Record<string, IntegrationCommand> {
	const configArg = (args: string[]) =>
		args
			.find((arg) => arg.startsWith("--config="))
			?.slice("--config=".length) ??
		(args.includes("--config")
			? args[args.indexOf("--config") + 1]
			: undefined) ??
		state.config;

	return {
		login: {
			summary: "Log in to the Shopify CLI (opens a browser)",
			usage: "login",
			run: ({ root }) => {
				shopifyLogin(root ?? process.cwd());
				log.success(
					"Logged in. Restart a stopped shopify app with `r` or `buncargo restart shopify`.",
				);
				return 0;
			},
		},
		link: {
			summary:
				"Link an app toml to a Shopify app, keeping its scopes, webhooks and dev store",
			usage: "link [--config=<name>]",
			run: ({ args, root }) => {
				const cwd = root ?? process.cwd();
				const { path, before } = linkShopifyApp(cwd, configArg(args));
				log.line(describeChange(path, before));
				return 0;
			},
		},
		env: {
			summary: "Print the app toml as JSON (client_id, scopes, URLs)",
			usage: "env [--config=<name>]",
			run: async ({ args, root }) => {
				const { raw: _raw, ...config } = readShopifyAppConfig(
					configArg(args),
					root,
				);
				log.line(JSON.stringify(config, null, 2));
				return 0;
			},
		},
	};
}
