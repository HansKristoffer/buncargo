import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shopifyConfigFile } from "./app-config";
import { resolveShopifyBin, shopifyEnv } from "./cli";

/**
 * `buncargo shopify link`: point a toml at a Shopify app without letting the
 * CLI rewrite it.
 *
 * `shopify app config link` rebuilds the whole file from the app's remote
 * config, which for a fresh dev app is bare: scopes, webhooks, the app proxy
 * and `web_directories` are gone. So the CLI links into a scratch file, and
 * only `client_id` and `name` are taken from it; everything else comes from
 * the template config (`shopify.app.toml`), and the target's own
 * `dev_store_url` is kept.
 */

const TEMPLATE = "shopify.app.toml";

const tomlString = (value: string) => JSON.stringify(value);

/** A top-level `key = value` (before the first table), replaced or added. */
export function setTopLevelKey(
	toml: string,
	key: string,
	value: string,
): string {
	const firstTable = toml.search(/^[ \t]*\[/m);
	const head = firstTable < 0 ? toml : toml.slice(0, firstTable);
	const tail = firstTable < 0 ? "" : toml.slice(firstTable);
	const line = `${key} = ${tomlString(value)}`;
	const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
	if (pattern.test(head)) return `${head.replace(pattern, line)}${tail}`;
	return `${line}\n${head}${tail}`;
}

/** `[build] dev_store_url`, replaced or added. */
export function setDevStoreUrl(toml: string, value: string): string {
	const line = `dev_store_url = ${tomlString(value)}`;
	const build = /^[ \t]*\[build\][ \t]*(?:#.*)?$/m.exec(toml);
	if (!build) return `${toml.replace(/\n*$/, "\n")}\n[build]\n${line}\n`;
	const start = build.index + build[0].length;
	const next = toml.slice(start).search(/^[ \t]*\[/m);
	const end = next < 0 ? toml.length : start + next;
	const section = toml.slice(start, end);
	const key = /^[ \t]*dev_store_url[ \t]*=.*$/m;
	const updated = key.test(section)
		? section.replace(key, line)
		: `\n${line}${section}`;
	return `${toml.slice(0, start)}${updated}${toml.slice(end)}`;
}

function topLevelValue(toml: string, key: string): string | undefined {
	const raw = Bun.TOML.parse(toml) as Record<string, unknown>;
	const value = raw[key];
	return typeof value === "string" ? value : undefined;
}

function devStoreUrl(toml: string): string | undefined {
	const raw = Bun.TOML.parse(toml) as { build?: { dev_store_url?: unknown } };
	const value = raw.build?.dev_store_url;
	return typeof value === "string" ? value : undefined;
}

/**
 * The target's new content: the template with the linked app's `client_id`
 * and `name`, keeping the target's own `dev_store_url`.
 *
 * The edits are line-based, so the result is checked: it must parse to
 * exactly the template plus those three values. Anything the edits cannot
 * express (a multi-line string, a dotted `build.dev_store_url`) throws
 * instead of writing a broken or different toml.
 */
export function mergeLinkedConfig(input: {
	template: string;
	linked: { clientId: string; name?: string };
	existing?: string;
}): string {
	let toml = setTopLevelKey(input.template, "client_id", input.linked.clientId);
	if (input.linked.name) toml = setTopLevelKey(toml, "name", input.linked.name);
	const store = input.existing ? devStoreUrl(input.existing) : undefined;
	if (store) toml = setDevStoreUrl(toml, store);

	const expected = Bun.TOML.parse(input.template) as Record<string, unknown>;
	expected.client_id = input.linked.clientId;
	if (input.linked.name) expected.name = input.linked.name;
	if (store)
		expected.build = {
			...(expected.build as Record<string, unknown> | undefined),
			dev_store_url: store,
		};
	let actual: unknown;
	try {
		actual = Bun.TOML.parse(toml);
	} catch {
		actual = undefined;
	}
	if (!Bun.deepEquals(actual, expected))
		throw new Error(
			`could not edit the toml safely. Set client_id = ${tomlString(input.linked.clientId)}${input.linked.name ? ` and name = ${tomlString(input.linked.name)}` : ""} in it by hand.`,
		);
	return toml;
}

/**
 * Link `config` to a Shopify app the user picks in the CLI. Returns the file
 * written and its previous content, so the caller can show what changed.
 */
export function linkShopifyApp(
	root: string,
	config: string,
	options: { clientId?: string } = {},
): { path: string; before: string | undefined; after: string } {
	const scratchName = `buncargo-link-${process.pid}`;
	const scratch = join(root, shopifyConfigFile(scratchName));
	try {
		const result = Bun.spawnSync(
			[
				resolveShopifyBin(root),
				"app",
				"config",
				"link",
				"--config",
				scratchName,
				...(options.clientId ? ["--client-id", options.clientId] : []),
			],
			{
				cwd: root,
				stdio: ["inherit", "inherit", "inherit"],
				env: shopifyEnv(),
			},
		);
		if (result.exitCode !== 0 || !existsSync(scratch))
			throw new Error("`shopify app config link` did not link an app");
		const linked = readFileSync(scratch, "utf8");
		const clientId = topLevelValue(linked, "client_id");
		if (!clientId) throw new Error("the linked config has no client_id");

		const path = join(root, shopifyConfigFile(config));
		const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		const templatePath = join(root, TEMPLATE);
		const template = existsSync(templatePath)
			? readFileSync(templatePath, "utf8")
			: (before ?? linked);
		const after = mergeLinkedConfig({
			template,
			linked: { clientId, name: topLevelValue(linked, "name") },
			existing: before,
		});
		// Atomically: a half-written toml is worse than the old one.
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, after);
		renameSync(temporary, path);
		return { path, before, after };
	} finally {
		rmSync(scratch, { force: true });
	}
}

/** A diff of the change, through git when it is there. */
export function describeChange(
	path: string,
	before: string | undefined,
): string {
	if (before === undefined) return `Created ${path}`;
	const old = join(tmpdir(), `buncargo-link-${process.pid}.toml`);
	writeFileSync(old, before);
	try {
		const result = Bun.spawnSync(
			["git", "diff", "--no-index", "--color=always", old, path],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const diff = result.stdout.toString().trim();
		return diff || `${path} is unchanged`;
	} catch {
		return `Wrote ${path}`;
	} finally {
		rmSync(old, { force: true });
	}
}
