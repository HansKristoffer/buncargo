import { loadDevEnv } from "../../loader";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";
import { argumentsError } from "../errors";
import * as log from "../log";
import { adoptLiveCaptures } from "../run-publish";

const HELP: FlagSpec = {
	name: "--help",
	kind: "boolean",
	description: "Show this help message",
};

export const GENERATE_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo generate",
	flags: [HELP],
	examples: [
		{
			command: "BASE_URL=https://… bunx buncargo generate",
			description: "Render generatedFiles in CI, from the environment",
		},
	],
};

/**
 * Render every generated file once, without starting anything.
 *
 * A live `dev` run's captures and public URLs are used when there is one; in
 * CI there is none, and a render reads what the environment hands it:
 * `BASE_URL=https://… bunx buncargo generate`.
 */
export async function handleGenerate(args: string[]): Promise<number> {
	if (readBooleanFlag(args, HELP)) {
		console.log(formatCommandHelp(GENERATE_COMMAND_SPEC));
		return 0;
	}
	const unexpected = [
		...findUnknownFlags(GENERATE_COMMAND_SPEC, args),
		...readPositionals(GENERATE_COMMAND_SPEC, args),
	];
	if (unexpected.length > 0) {
		throw argumentsError(
			[`Unexpected argument: ${unexpected.join(" ")}`],
			"generate",
		);
	}

	const env = await loadDevEnv({ readOnly: true });
	const files = env.generatedFiles ?? [];
	if (files.length === 0) {
		log.info("No generatedFiles configured.");
		return 0;
	}

	await adoptLiveCaptures(env);
	const changed = new Set(env.renderGeneratedFiles());
	for (const file of files) {
		if (changed.has(file.path)) log.done(`Wrote ${file.path}`);
		else log.line(`  ${file.path} is up to date`);
	}
	return 0;
}
