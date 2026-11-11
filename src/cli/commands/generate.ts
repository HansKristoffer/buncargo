import { adoptLiveCaptures } from "../../core/run-publish";
import { internalsOf } from "../../environment";
import { loadDevEnv } from "../../loader";
import { BASE_EXITS, defineCommand } from "../command-spec";
import * as log from "../log";

/**
 * Render every generated file once, without starting anything.
 *
 * A live `dev` run's captures and public URLs are used when there is one; in
 * CI there is none, and a render reads what the environment hands it:
 * `BASE_URL=https://… bunx buncargo generate`.
 */
async function generate(): Promise<number> {
	const env = await loadDevEnv({ readOnly: true });
	const files = env.generatedFiles ?? [];
	if (files.length === 0) {
		log.info("No generatedFiles configured.");
		return 0;
	}

	await adoptLiveCaptures(env);
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
		flags: {},
		examples: [
			{
				command: "BASE_URL=https://… bunx buncargo generate",
				description: "Render generatedFiles in CI, from the environment",
			},
		],
	},
	exits: BASE_EXITS,
	run: () => generate(),
});
