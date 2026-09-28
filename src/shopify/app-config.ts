import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findMonorepoRoot } from "../core/ports";

/**
 * `shopify.app*.toml`, read for app code, scripts and the integration.
 *
 * The toml is the source of truth for `client_id`, scopes and the app URL;
 * reading it here removes the need to copy them into secrets or env files.
 */

export interface ShopifyWebhookSubscription {
	topics?: string[];
	compliance_topics?: string[];
	uri: string;
	filter?: string;
}

export interface ShopifyAppConfig {
	/** The config name: `aroxb2b-print` for `shopify.app.aroxb2b-print.toml`, else `shopify.app.toml`. */
	name: string;
	/** Absolute path of the toml. */
	path: string;
	clientId: string;
	appName?: string;
	applicationUrl?: string;
	embedded?: boolean;
	scopes: string[];
	/** `[webhooks] api_version`. */
	apiVersion?: string;
	appProxy?: { url: string; prefix: string; subpath: string };
	webhooks: ShopifyWebhookSubscription[];
	webDirectories?: string[];
	automaticallyUpdateUrlsOnDev?: boolean;
	devStoreUrl?: string;
	/** Everything else, as parsed. */
	raw: Record<string, unknown>;
}

/**
 * The file a config name refers to. Accepts `shopify.app.toml`, a bare name
 * (`aroxb2b-print`), or `shopify.app.<name>.toml`, as Shopify CLI's
 * `--config` does.
 */
export function shopifyConfigFile(name = "shopify.app.toml"): string {
	if (name.endsWith(".toml")) return name;
	return name === "shopify.app"
		? "shopify.app.toml"
		: `shopify.app.${name}.toml`;
}

/** The name Shopify CLI's `--config` takes for a toml file. */
export function shopifyConfigName(file: string): string {
	const match = /^shopify\.app\.(.+)\.toml$/.exec(file);
	return match?.[1] ?? "shopify.app.toml";
}

/** Every `shopify.app*.toml` at the root, sorted. */
export function listShopifyAppConfigs(root = findMonorepoRoot()): string[] {
	return readdirSync(root)
		.filter((file) => /^shopify\.app(\..+)?\.toml$/.test(file))
		.sort();
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function scopesOf(raw: Record<string, unknown>): string[] {
	const accessScopes = raw.access_scopes as { scopes?: unknown } | undefined;
	const scopes = asString(accessScopes?.scopes) ?? asString(raw.scopes) ?? "";
	return scopes
		.split(",")
		.map((scope) => scope.trim())
		.filter(Boolean);
}

export function parseShopifyAppConfig(
	text: string,
	path: string,
	name: string,
): ShopifyAppConfig {
	const raw = Bun.TOML.parse(text) as Record<string, unknown>;
	const clientId = asString(raw.client_id);
	if (!clientId) throw new Error(`${path} has no client_id`);

	const webhooks = (raw.webhooks ?? {}) as {
		api_version?: unknown;
		subscriptions?: unknown;
	};
	const build = (raw.build ?? {}) as Record<string, unknown>;
	const proxy = raw.app_proxy as Record<string, unknown> | undefined;

	return {
		name,
		path,
		clientId,
		appName: asString(raw.name),
		applicationUrl: asString(raw.application_url),
		embedded: typeof raw.embedded === "boolean" ? raw.embedded : undefined,
		scopes: scopesOf(raw),
		apiVersion: asString(webhooks.api_version),
		appProxy:
			proxy && typeof proxy.url === "string"
				? {
						url: proxy.url,
						prefix: String(proxy.prefix ?? "apps"),
						subpath: String(proxy.subpath ?? ""),
					}
				: undefined,
		webhooks: Array.isArray(webhooks.subscriptions)
			? (webhooks.subscriptions as ShopifyWebhookSubscription[])
			: [],
		webDirectories: Array.isArray(raw.web_directories)
			? (raw.web_directories as string[])
			: undefined,
		automaticallyUpdateUrlsOnDev:
			typeof build.automatically_update_urls_on_dev === "boolean"
				? build.automatically_update_urls_on_dev
				: undefined,
		devStoreUrl: asString(build.dev_store_url),
		raw,
	};
}

/**
 * Read a Shopify app config by name (`shopify.app.toml` by default).
 *
 * ```ts
 * const { clientId, scopes, appProxy } = readShopifyAppConfig("aroxb2b-print");
 * ```
 */
export function readShopifyAppConfig(
	name?: string,
	root = findMonorepoRoot(),
): ShopifyAppConfig {
	const file = shopifyConfigFile(name);
	const path = join(root, file);
	if (!existsSync(path)) {
		throw new Error(
			`No ${file} in ${root}. Link one with \`shopify app config link\`.`,
		);
	}
	return parseShopifyAppConfig(
		readFileSync(path, "utf8"),
		path,
		shopifyConfigName(file),
	);
}
