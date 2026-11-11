import { environmentOpenUrl } from "../../core/app-url";
import { openUrl } from "../../core/open-url";
import { urlHostOverride } from "../../core/runtime-flags";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { CliError } from "../errors";
import * as log from "../log";
import { loadLiveEnv } from "./load-env";

/**
 * `buncargo url` / `buncargo open`: every URL this checkout's run knows, under
 * the name `url` lists it by. App names first, then services, then capture
 * names, then the labels of captures and integrations, which is what
 * BuncargoBar shows. `url` also prints a service's connection URL
 * (`postgres://…`); `open` takes only what a browser can open.
 */

export interface OpenSource {
	apps: Readonly<Record<string, unknown>>;
	services: Readonly<Record<string, unknown>>;
	urls: Readonly<Record<string, string | undefined>>;
	loopbackUrls?: Readonly<Record<string, string | undefined>>;
	publicUrls: Readonly<Record<string, string | undefined>>;
	hosts?: { active: boolean } | null;
	captured: Readonly<Record<string, string>>;
	details(): Record<string, string>;
}

const isHttpUrl = (value: string | undefined): value is string =>
	value !== undefined && /^https?:\/\//.test(value);

const isAnyUrl = (value: string | undefined): value is string =>
	value !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

/**
 * Name → URL, each URL once, under the first name that reaches it. `open`
 * takes browser URLs only; `url` also takes a service's connection URL
 * (`postgres://…`, `redis://…`), which is what an agent asking for
 * `url postgres` wants.
 */
export function openTargets(
	env: OpenSource,
	options: {
		connectionUrls: boolean;
		/** Whether app URLs carry `BUNCARGO_URL_HOST` instead of loopback. */
		urlHostSet: boolean;
	},
): Record<string, string> {
	const targets: Record<string, string> = {};
	const seen = new Set<string>();
	const add = (
		name: string,
		url: string | undefined,
		accepts: (value: string | undefined) => value is string = isHttpUrl,
	) => {
		if (!accepts(url) || seen.has(url) || name in targets) return;
		seen.add(url);
		targets[name] = url;
	};

	// The app's own URL is the one the TUI's `o` and BuncargoBar open.
	for (const app of Object.keys(env.apps)) {
		add(app, environmentOpenUrl(env, app, options.urlHostSet));
	}
	const serviceAccepts = options.connectionUrls ? isAnyUrl : isHttpUrl;
	for (const service of Object.keys(env.services))
		add(
			service,
			environmentOpenUrl(env, service, options.urlHostSet),
			serviceAccepts,
		);
	for (const [name, value] of Object.entries(env.captured)) add(name, value);
	for (const [label, value] of Object.entries(env.details())) add(label, value);
	return targets;
}

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(\.\d+){3}|\[::1\])$/;

/**
 * A plain `http://` URL on a host other than this machine. A browser gives a
 * page there no secure context: no `crypto.randomUUID`, clipboard or service
 * workers. `BUNCARGO_URL_HOST` makes every app URL one of these.
 */
function isInsecureRemoteUrl(url: string): boolean {
	const parsed = URL.parse(url);
	if (!parsed) return false;
	const { protocol, hostname } = parsed;
	return protocol === "http:" && !LOOPBACK_HOST.test(hostname);
}

function insecureWarning(names: string[]): string | undefined {
	if (names.length === 0) return undefined;
	const command =
		names.length === 1
			? `buncargo url ${names[0]} --local`
			: "buncargo url <name> --local";
	const what = `Plain HTTP on a remote host (${names.join(", ")})`;
	const why =
		"pages there get no secure context (crypto.randomUUID, clipboard, service workers)";
	return `${what}: ${why}. A browser on this machine wants \`${command}\`.`;
}

/** Exact name first, then case-insensitive, so `open "shopify admin"` works. */
export function findTarget(
	targets: Record<string, string>,
	name: string,
): string | undefined {
	if (targets[name]) return targets[name];
	const lower = name.toLowerCase();
	return Object.entries(targets).find(
		([key]) => key.toLowerCase() === lower,
	)?.[1];
}

export function resolveTarget(
	env: Pick<OpenSource, "services">,
	targets: Record<string, string>,
	name: string,
	command: "url" | "open",
): string {
	const url = findTarget(targets, name);
	if (url) return url;
	const names = Object.keys(targets);
	const available =
		names.length > 0
			? `Available: ${names.join(", ")}`
			: "Nothing has a URL yet: is `buncargo dev` running?";
	if (!(name in env.services))
		throw new CliError(`No URL named "${name}".`, [available]);
	const connect = `\`buncargo url ${name}\` prints how to connect`;
	const why =
		command === "open"
			? `no URL a browser opens; ${connect}`
			: "no URL: it publishes no port; `buncargo status` lists its container";
	throw new CliError(`The service "${name}" has ${why}.`, [available]);
}

/**
 * What `url` prints: the lines for stdout, and a warning for stderr when one
 * of them is plain HTTP on a remote host. `urlHost` is `BUNCARGO_URL_HOST`,
 * which `--local` sets aside.
 */
export function urlOutput(
	env: OpenSource,
	request: { name: string | undefined; local: boolean },
	urlHost: string | undefined,
): { lines: string[]; warning?: string } {
	const targets = openTargets(env, {
		connectionUrls: true,
		urlHostSet: !request.local && urlHost !== undefined,
	});
	if (request.name !== undefined) {
		const url = resolveTarget(env, targets, request.name, "url");
		const insecure = isInsecureRemoteUrl(url) ? [request.name] : [];
		return { lines: [url], warning: insecureWarning(insecure) };
	}

	const entries = Object.entries(targets);
	if (entries.length === 0)
		throw new CliError("Nothing has a URL yet: is `buncargo dev` running?");
	const width = Math.max(...entries.map(([key]) => key.length));
	const insecure = entries
		.filter(([, url]) => isInsecureRemoteUrl(url))
		.map(([key]) => key);
	return {
		lines: entries.map(([key, url]) => `${key.padEnd(width)}  ${url}`),
		warning: insecureWarning(insecure),
	};
}

export const urlCommand = defineCommand({
	spec: {
		name: "url",
		summary: "Print an app's or a captured URL (lists them without a name)",
		flags: {
			local: {
				kind: "boolean",
				description:
					"The URL for a browser on this machine: loopback instead of BUNCARGO_URL_HOST",
			},
		},
		args: [{ name: "<name>", description: "A name `buncargo url` lists" }],
		examples: [
			{ command: "buncargo url", description: "List every URL, by name" },
			{ command: "buncargo url api", description: "Print one" },
			{
				command: "buncargo url api --local",
				description: "The one your own browser opens",
			},
			{
				command: "buncargo url postgres",
				description: "A service's URL, or its connection URL",
			},
		],
	},
	exits: BASE_EXITS,
	run: async ({ values, positionals: [name] }) => {
		const env = await loadLiveEnv();
		const { lines, warning } = urlOutput(
			env,
			{ name, local: values.local },
			urlHostOverride(),
		);
		for (const line of lines) log.line(line);
		if (warning) log.warn(warning);
		return 0;
	},
});

export const openCommand = defineCommand({
	spec: {
		name: "open",
		summary: "Open the primary app, or any URL `url` lists",
		flags: {},
		args: [
			{ name: "<name>", description: "A name `buncargo url` lists" },
			{ name: "<capture>", description: "One of that app's captured URLs" },
		],
		examples: [
			{ command: "buncargo open", description: "Open the primary app" },
			{
				command: "buncargo open api",
				description: "What `o` opens in the TUI",
			},
			{
				command: "buncargo open previewUrl",
				description: "Open a captured URL",
			},
			{
				command: "buncargo open shopify previewUrl",
				description: "An app's captured URL, as its declared action does",
			},
		],
	},
	exits: { ...BASE_EXITS, 1: "no such URL, no browser here, or bad arguments" },
	run: async ({ positionals: [name, capture] }) => {
		const env = await loadLiveEnv();
		if (name !== undefined && capture !== undefined) {
			const url = (env.captured as Record<string, string | undefined>)[capture];
			if (!(name in env.apps))
				throw new CliError(`"${name}" is not an app of this config.`, [
					`Configured apps: ${Object.keys(env.apps).join(", ") || "none"}`,
				]);
			if (!url)
				throw new CliError(`${name} has not printed ${capture} yet.`, [
					"Is `buncargo dev` running? `buncargo url` lists what is known.",
				]);
			return openOrFail(url);
		}
		const targets = openTargets(env, {
			connectionUrls: false,
			urlHostSet: urlHostOverride() !== undefined,
		});

		const target = name ?? env.resolvePrimaryApp();
		if (target === undefined) {
			throw new CliError("No apps to open: name a URL from `buncargo url`.");
		}
		return openOrFail(resolveTarget(env, targets, target, "open"));
	},
});

/**
 * 0 when a browser opened. A machine with no opener (a headless server) must
 * not report success: an agent would tell the person it opened.
 */
function openOrFail(url: string) {
	log.info(`Opening ${url}`);
	if (openUrl(url)) return 0;
	throw new CliError(`Could not open a browser here. The URL is ${url}`, [
		"On a remote machine, give that URL to the person at the browser.",
	]);
}
