import { detachedRunMode } from "../../core/runtime-flags";
import { createNoopPhaseTimer, createPhaseTimer } from "../../core/timing";
import { defineCommand } from "../command-spec";
import {
	assertDevArgs,
	DEV_EXITS,
	DEV_JSON,
	DEV_SPEC,
	ignoredFlagWarnings,
	requestedApps,
	timingRequested,
} from "../dev-flags";
import * as log from "../log";

export const devCommand = defineCommand({
	spec: DEV_SPEC,
	exits: DEV_EXITS,
	json: DEV_JSON,
	run: async (parsed) => {
		assertDevArgs(parsed);
		// The background run loads the config and builds the environment; this
		// process only starts it and waits. One already in the background is
		// refused by `runCli`.
		if (parsed.values.detach && detachedRunMode() === undefined) {
			const { findCheckoutRoot } =
				await import("../../loader/find-config-file");
			const root = findCheckoutRoot(process.cwd());
			if (root === undefined) {
				log.fail(
					"No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })",
				);
			}

			for (const warning of ignoredFlagWarnings(parsed.values)) {
				log.warn(warning);
			}

			const { DETACH_TIMEOUT_MS, runDetached } = await import("../dev-detach");
			return runDetached({
				root,
				keep: parsed.values.keep,
				json: parsed.values.json,
				argv: process.argv,
				timeoutMs: DETACH_TIMEOUT_MS,
			});
		}

		const timer = timingRequested(parsed.values)
			? createPhaseTimer({ startedAt: 0, json: parsed.values["timing-json"] })
			: createNoopPhaseTimer();

		try {
			// Overlap loading run-cli with config evaluation so the CLI runtime
			// module graph is ready the moment `loadDevEnv` returns.
			const runCliModule = import("../run-cli");
			runCliModule.catch(() => {});

			// The runtime has to be known before the environment is built, so it is
			// read here rather than inside runCli, which is handed a finished env.
			const env = await timer.measure("config and ports", async () =>
				(await import("../../loader")).loadDevEnv({
					containerRuntime: parsed.values.runtime,
					profile: parsed.values.profile,
					onlyApps: requestedApps(parsed),
				}),
			);

			await (await runCliModule).runCli(env, { parsed, timer });
		} catch (error) {
			timer.report();
			throw error;
		}

		return 0;
	},
});
