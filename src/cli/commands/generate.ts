import { internalsOf } from "../../environment";
import { BASE_EXITS, defineCommand } from "../command-spec";
import * as log from "../log";
import { loadCommandEnv } from "./load-env";

/**
 * Render every generated file once, without starting anything.
 *
 * A live `dev` run's profile, ports, captures and public URLs are used when
 * there is one; in CI there is none, and a render reads what the environment
 * hands it: `BASE_URL=https://… bunx buncargo generate`.
 */
async function generate(profile: string | undefined): Promise<number> {
	const env = await loadCommandEnv({ profile });
	const files = env.generatedFiles ?? [];
	if (files.length === 0) {
		log.info("No generatedFiles configured.");
		return 0;
	}

	const changed = new Set(internalsOf(env).renderGeneratedFiles());
	for (const file of files) {
		if (changed.has(file.path)) log.done(`Wrote ${file.path}`);
		else log.line(`  ${file.path} is up to date`);
	}

	return 0;
}

export const generateCommand = defineCommand({
	spec: {
		name: "generate",
		summary: "Render generatedFiles without starting anything",
		flags: {
			profile: {
				kind: "string",
				value: "<name>",
				description:
					"Apply a profile's env overrides (default: the active run's profile, or default)",
			},
		},
		examples: [
			{
				command: "BASE_URL=https://… bunx buncargo generate",
				description: "Render generatedFiles in CI, from the environment",
			},
		],
	},
	exits: BASE_EXITS,
	run: ({ values }) => generate(values.profile),
});
