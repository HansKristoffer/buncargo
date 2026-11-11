import { isDiscoveredApp } from "../../config/discover-apps";
import { loadDevEnv } from "../../loader";
import { BASE_EXITS, commaList, defineCommand } from "../command-spec";
import { CliError } from "../errors";
import * as log from "../log";

/**
 * Run apps' `buildCommand`s one at a time, each with its app's env, stopping
 * at the first failure. Sequential on purpose: builds are what CI and deploys
 * run, and interleaved output from parallel builds hides which one failed.
 */
async function build(
	only: readonly string[] | undefined,
	discoveredOnly: boolean,
): Promise<number> {
	const env = await loadDevEnv({ readOnly: true });
	const unknown = (only ?? []).filter((name) => !env.apps[name]);
	if (unknown.length > 0) {
		throw new CliError(`Unknown app(s): ${unknown.join(", ")}`, [
			`Configured apps: ${Object.keys(env.apps).join(", ") || "none"}`,
		]);
	}

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

export const buildCommand = defineCommand({
	spec: {
		name: "build",
		summary: "Run apps' buildCommand one at a time",
		flags: {
			discovered: {
				kind: "boolean",
				description: "Only apps found by discoverApps()",
			},
			apps: {
				kind: "string",
				value: "<apps>",
				description: "Only these apps (as <app>...)",
			},
		},
		args: [{ name: "<app>", description: "Only these apps", variadic: true }],
		examples: [
			{
				command: "buncargo build --discovered",
				description: "Build every discovered extension, one at a time",
			},
		],
	},
	exits: {
		...BASE_EXITS,
		1: "a build failed (its own code), or bad arguments",
	},
	run: ({ values, positionals }) => {
		if (positionals.length > 0 && values.apps !== undefined)
			throw new CliError(
				"Name the apps as arguments or with --apps, not both.",
			);
		const only =
			positionals.length > 0
				? [...positionals]
				: values.apps === undefined
					? undefined
					: commaList(values.apps);
		return build(only, values.discovered);
	},
});
