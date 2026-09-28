import { isDiscoveredApp } from "../../config/discover-apps";
import { loadDevEnv } from "../../loader";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	discovered: {
		name: "--discovered",
		kind: "boolean",
		description: "Only apps found by discoverApps()",
	},
	apps: {
		name: "--apps",
		kind: "string",
		valueHint: "=<apps>",
		description: "Only these apps",
	},
} as const satisfies Record<string, FlagSpec>;

export const BUILD_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo build [--discovered] [--apps=<apps>]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "buncargo build --discovered",
			description: "Build every discovered extension, one at a time",
		},
	],
};

/**
 * Run apps' `buildCommand`s one at a time, each with its app's env, stopping
 * at the first failure. Sequential on purpose: builds are what CI and deploys
 * run, and interleaved output from parallel builds hides which one failed.
 */
export async function handleBuild(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(BUILD_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const only = readStringFlag(args, FLAGS.apps, errors)
		?.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	errors.push(
		...findUnknownFlags(BUILD_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
	);
	if (errors.length > 0) throw argumentsError(errors, "build");

	const env = await loadDevEnv({ readOnly: true });
	const unknown = (only ?? []).filter((name) => !env.apps[name]);
	if (unknown.length > 0) {
		throw new CliError(`Unknown app(s): ${unknown.join(", ")}`);
	}

	const discoveredOnly = readBooleanFlag(args, FLAGS.discovered);
	const selected = Object.entries(env.apps).flatMap(([name, app]) =>
		app.buildCommand &&
		(!only || only.includes(name)) &&
		(!discoveredOnly || isDiscoveredApp(app))
			? [{ name, command: app.buildCommand }]
			: [],
	);
	if (selected.length === 0) {
		log.info("Nothing to build.");
		return 0;
	}

	for (const { name, command } of selected) {
		log.info(`🔨 ${name}: ${command}`);
		const result = await env.exec(command, {
			app: name,
			verbose: true,
			throwOnError: false,
		});
		if (result.exitCode !== 0) {
			log.error(`${name} failed to build (exit ${result.exitCode}).`);
			return result.exitCode;
		}
	}
	log.success(
		`Built ${selected.length} app${selected.length === 1 ? "" : "s"}.`,
	);
	return 0;
}
