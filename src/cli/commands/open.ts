import { appEntryPath, preferredAppUrl } from "../../core/app-url";
import { openUrl } from "../../core/open-url";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";
import { loadLiveEnv } from "./runtime";

/**
 * `buncargo url` / `buncargo open`: every URL this checkout's run knows, under
 * the name `url` lists it by. App names first, then capture names, then the
 * labels of captures and integrations, which is what BuncargoBar shows.
 */

const HELP = {
	name: "--help",
	kind: "boolean",
	description: "Show this help message",
} as const;

export const URL_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo url [<name>]",
	flags: [HELP],
	examples: [
		{ command: "buncargo url", description: "List every URL, by name" },
		{ command: "buncargo url api", description: "Print one" },
	],
};

export const OPEN_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo open [<name>] [<capture>]",
	flags: [HELP],
	examples: [
		{ command: "buncargo open", description: "Open the primary app" },
		{ command: "buncargo open api", description: "What `o` opens in the TUI" },
		{ command: "buncargo open previewUrl", description: "Open a captured URL" },
		{
			command: "buncargo open shopify previewUrl",
			description: "An app's captured URL, as its declared action does",
		},
	],
};

export interface OpenSource {
	apps: Readonly<Record<string, unknown>>;
	urls: Readonly<Record<string, string | undefined>>;
	loopbackUrls?: Readonly<Record<string, string | undefined>>;
	publicUrls: Readonly<Record<string, string | undefined>>;
	hosts?: { active: boolean } | null;
	captured: Readonly<Record<string, string>>;
	details(): Record<string, string>;
}

const isUrl = (value: string | undefined): value is string =>
	value !== undefined && /^https?:\/\//.test(value);

/** Name → URL, each URL once, under the first name that reaches it. */
export function openTargets(env: OpenSource): Record<string, string> {
	const targets: Record<string, string> = {};
	const seen = new Set<string>();
	const add = (name: string, url: string | undefined) => {
		if (!isUrl(url) || seen.has(url) || name in targets) return;
		seen.add(url);
		targets[name] = url;
	};

	// The app's own URL is the one the TUI's `o` and BuncargoBar open.
	for (const app of Object.keys(env.apps)) {
		add(
			app,
			preferredAppUrl(
				{
					url: env.urls[app],
					loopbackUrl: env.loopbackUrls?.[app],
					publicUrl: env.publicUrls[app],
					entryPath: appEntryPath(env.apps[app]),
				},
				env.hosts?.active ?? true,
			),
		);
	}
	for (const [name, value] of Object.entries(env.captured)) add(name, value);
	for (const [label, value] of Object.entries(env.details())) add(label, value);
	return targets;
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

function parseNames(
	spec: CommandSpec,
	args: string[],
	command: string,
	max: number,
) {
	const names = readPositionals(spec, args);
	const errors = [
		...findUnknownFlags(spec, args).map((flag) => `Unknown flag: ${flag}`),
		...names.slice(max).map((arg) => `Unexpected argument: ${arg}`),
	];
	if (errors.length > 0) throw argumentsError(errors, command);
	return names;
}

function resolveTarget(targets: Record<string, string>, name: string): string {
	const url = findTarget(targets, name);
	if (url) return url;
	const names = Object.keys(targets);
	throw new CliError(
		`No URL named "${name}".`,
		names.length > 0
			? [`Available: ${names.join(", ")}`]
			: ["Nothing has a URL yet: is `buncargo dev` running?"],
	);
}

export async function handleUrl(args: string[]): Promise<number> {
	if (readBooleanFlag(args, HELP)) {
		console.log(formatCommandHelp(URL_COMMAND_SPEC));
		return 0;
	}
	const [name] = parseNames(URL_COMMAND_SPEC, args, "url", 1);
	const targets = openTargets(await loadLiveEnv());

	if (name !== undefined) {
		log.line(resolveTarget(targets, name));
		return 0;
	}
	const entries = Object.entries(targets);
	if (entries.length === 0) {
		log.error("Nothing has a URL yet: is `buncargo dev` running?");
		return 1;
	}
	const width = Math.max(...entries.map(([key]) => key.length));
	for (const [key, url] of entries) log.line(`${key.padEnd(width)}  ${url}`);
	return 0;
}

export async function handleOpen(args: string[]): Promise<number> {
	if (readBooleanFlag(args, HELP)) {
		console.log(formatCommandHelp(OPEN_COMMAND_SPEC));
		return 0;
	}
	const [name, capture] = parseNames(OPEN_COMMAND_SPEC, args, "open", 2);
	const env = await loadLiveEnv();
	if (name !== undefined && capture !== undefined) {
		const url = (env.captured as Record<string, string | undefined>)[capture];
		if (!(name in env.apps))
			throw new CliError(`"${name}" is not an app of this config.`);
		if (!url)
			throw new CliError(`${name} has not printed ${capture} yet.`, [
				"Is `buncargo dev` running? `buncargo url` lists what is known.",
			]);
		log.info(`Opening ${url}`);
		openUrl(url);
		return 0;
	}
	const targets = openTargets(env);

	const target = name ?? env.resolvePrimaryApp();
	if (target === undefined) {
		throw new CliError("No apps to open: name a URL from `buncargo url`.");
	}
	const url = resolveTarget(targets, target);
	log.info(`Opening ${url}`);
	openUrl(url);
	return 0;
}
