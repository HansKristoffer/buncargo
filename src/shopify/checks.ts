import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupCheck } from "../types";
import {
	listShopifyAppConfigs,
	readShopifyAppConfig,
	type ShopifyAppConfig,
} from "./app-config";
import {
	isShopifyAppLinked,
	isShopifyLoggedIn,
	isTestedShopifyVersion,
	parseVersion,
	resolveShopifyBin,
	shopifyVersion,
} from "./cli";
import { patchWebDirectories, SHOPIFY_WEB_DIR } from "./web";

function failed(detail: string) {
	return { ok: false, detail };
}

/** `extensions/*\/shopify.extension.toml` api_versions, by extension. */
function extensionApiVersions(root: string): Map<string, string> {
	const versions = new Map<string, string>();
	for (const path of new Bun.Glob(
		"extensions/*/shopify.extension.toml",
	).scanSync({
		cwd: root,
		onlyFiles: true,
	})) {
		try {
			const raw = Bun.TOML.parse(readFileSync(join(root, path), "utf8")) as {
				api_version?: unknown;
			};
			if (typeof raw.api_version === "string")
				versions.set(path, raw.api_version);
		} catch {
			// An unreadable extension toml is Shopify CLI's to report.
		}
	}
	return versions;
}

function subscriptionKeys(config: ShopifyAppConfig): string[] {
	return config.webhooks
		.flatMap((subscription) =>
			[
				...(subscription.topics ?? []),
				...(subscription.compliance_topics ?? []),
			].map((topic) => `${topic} -> ${subscription.uri}`),
		)
		.sort();
}

function proxyKey(config: ShopifyAppConfig): string | undefined {
	if (!config.appProxy) return undefined;
	// The dev toml names a path and the prod one an absolute URL on its host;
	// what has to agree is the path on the app server, prefix and subpath.
	let path = config.appProxy.url;
	try {
		path = new URL(path).pathname;
	} catch {
		// Already a path.
	}
	return `${config.appProxy.prefix}/${config.appProxy.subpath} -> ${path}`;
}

function differences(label: string, a: string[], b: string[]): string[] {
	const onlyA = a.filter((entry) => !b.includes(entry));
	const onlyB = b.filter((entry) => !a.includes(entry));
	return [
		...onlyA.map((entry) => `${label} ${entry} only in the first`),
		...onlyB.map((entry) => `${label} ${entry} only in the second`),
	];
}

/** `input.config` is the name passed to `--config`. */
export function shopifyChecks(input: { config: string }): SetupCheck[] {
	const read = (root: string) => readShopifyAppConfig(input.config, root);

	return [
		{
			name: "Shopify CLI is installed",
			fast: false,
			check: ({ root }) =>
				shopifyVersion(resolveShopifyBin(root), root) !== undefined ||
				failed("`shopify` is not in node_modules/.bin or on PATH"),
			fix: "bun add -d @shopify/cli",
		},
		{
			name: "Shopify CLI version is tested (3.90 and newer, below 5)",
			fast: false,
			severity: "warning",
			check: ({ root }) => {
				const version = shopifyVersion(resolveShopifyBin(root), root);
				const parsed = version ? parseVersion(version) : undefined;
				return (
					!parsed ||
					isTestedShopifyVersion(parsed) ||
					failed(`found ${version}`)
				);
			},
		},
		{
			name: "Logged in to Shopify",
			fast: false,
			check: () =>
				isShopifyLoggedIn() || failed("no stored Shopify CLI session"),
			fix: ({ root }) => {
				const result = Bun.spawnSync(
					[resolveShopifyBin(root), "auth", "login"],
					{
						cwd: root,
						stdio: ["inherit", "inherit", "inherit"],
					},
				);
				if (result.exitCode !== 0) throw new Error("shopify auth login failed");
			},
			fixDescription: "`shopify auth login` (opens a browser)",
		},
		{
			name: `${input.config} is linked to a Shopify app`,
			fast: false,
			check: ({ root }) => {
				const config = read(root);
				if (!/^[0-9a-f]{32}$/i.test(config.clientId)) {
					return failed(`client_id "${config.clientId}" is a placeholder`);
				}
				return (
					isShopifyAppLinked(root, config.clientId) ||
					failed("no .shopify/project.json entry for its client_id")
				);
			},
			fix: ({ root }) => {
				const result = Bun.spawnSync(
					[
						resolveShopifyBin(root),
						"app",
						"config",
						"link",
						"--config",
						input.config,
					],
					{ cwd: root, stdio: ["inherit", "inherit", "inherit"] },
				);
				if (result.exitCode !== 0)
					throw new Error("shopify app config link failed");
			},
			fixDescription: `\`shopify app config link --config ${input.config}\``,
		},
		{
			// The one that matters on every run: without it Shopify CLI starts a
			// second API and a second Vite beside buncargo's.
			name: `${input.config} web_directories is ${SHOPIFY_WEB_DIR}`,
			check: ({ root }) => {
				const dirs = read(root).webDirectories;
				return (
					(dirs?.length === 1 &&
						dirs[0]?.replace(/\/$/, "") === SHOPIFY_WEB_DIR) ||
					failed(
						dirs === undefined || dirs.length === 0
							? "empty, so Shopify CLI starts every shopify.web.toml it finds"
							: `set to ${JSON.stringify(dirs)}`,
					)
				);
			},
			fix: ({ root }) => {
				const path = read(root).path;
				writeFileSync(path, patchWebDirectories(readFileSync(path, "utf8")));
			},
			fixDescription: `set web_directories = ["${SHOPIFY_WEB_DIR}"] in the toml`,
		},
		{
			name: `${input.config} updates URLs on dev`,
			fast: false,
			severity: "warning",
			check: ({ root }) => {
				const config = read(root);
				// A quick tunnel is new every run: without this, Shopify keeps
				// sending the admin to last run's dead URL.
				return (
					config.automaticallyUpdateUrlsOnDev === true ||
					failed("[build] automatically_update_urls_on_dev is not true")
				);
			},
		},
		{
			name: "Shopify API versions agree",
			fast: false,
			severity: "warning",
			check: ({ root }) => {
				const versions = new Map<string, string>();
				for (const file of listShopifyAppConfigs(root)) {
					const version = readShopifyAppConfig(file, root).apiVersion;
					if (version) versions.set(file, version);
				}
				for (const [file, version] of extensionApiVersions(root)) {
					versions.set(file, version);
				}
				const distinct = new Set(versions.values());
				return (
					distinct.size <= 1 ||
					failed(
						[...versions]
							.map(([file, version]) => `${file}: ${version}`)
							.join(", "),
					)
				);
			},
		},
		{
			// The class of bug where the prod config silently lost its webhooks.
			name: "Shopify app configs agree on scopes, webhooks and app proxy",
			fast: false,
			severity: "warning",
			check: ({ root }) => {
				const configs = listShopifyAppConfigs(root).map((file) =>
					readShopifyAppConfig(file, root),
				);
				const [first, ...rest] = configs;
				if (!first) return true;
				const problems = rest.flatMap((other) =>
					[
						...differences(
							"scope",
							first.scopes.toSorted(),
							other.scopes.toSorted(),
						),
						...differences(
							"webhook",
							subscriptionKeys(first),
							subscriptionKeys(other),
						),
						...(proxyKey(first) !== proxyKey(other)
							? [`app_proxy ${proxyKey(first)} vs ${proxyKey(other)}`]
							: []),
					].map((problem) => `${first.name} vs ${other.name}: ${problem}`),
				);
				return problems.length === 0 || failed(problems.join("; "));
			},
		},
	];
}
