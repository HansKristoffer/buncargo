import { cliTool } from "../core/integration-cli";

/**
 * `firebase-tools`, looked up in the workdir, then the root. Run directly
 * rather than through `npx` or `bunx`, which forward the stop signal a second
 * time: the CLI reads a second signal as "exit now, skip the export".
 *
 * The tested range is where what the integration relies on (the `--config`
 * project directory, the hub's locator file, one clean shutdown per signal)
 * has held.
 */
export const firebaseCli = cliTool({
	name: "firebase",
	versionArgs: ["--version"],
	tested: { min: "13.0.0", below: "16.0.0" },
});
