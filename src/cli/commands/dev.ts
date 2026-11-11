import { detachedRunMode } from "../../core/runtime-flags";
import { createNoopPhaseTimer, createPhaseTimer } from "../../core/timing";
import { defineCommand } from "../command-spec";
import {
	assertDevArgs,
	DEV_SPEC,
	ignoredFlagWarnings,
	timingRequested,
} from "../dev-flags";
import * as log from "../log";

export const devCommand = defineCommand({
	spec: DEV_SPEC,
	exits: {
		0: "success: the run ended cleanly, or (--detach) every app is up",
		1: "failed, an app did not come up, or bad arguments",
		2: "--detach: apps still starting at the timeout; the run keeps going",
		130: "interrupted (Ctrl-C); 143 for SIGTERM",
	},
	json: "DetachedResultJson (--detach --json)",
	run: async (parsed) => {
		assertDevArgs(parsed);
		// The background run loads the config and builds the environment; this
		// process only starts it and waits. One already in the background is
		// refused by `runCli`.
		if (parsed.values.detach && detachedRunMode() === undefined) {
			const { findCheckoutRoot } =
				await import("../../loader/find-config-file");
			const root = findCheckoutRoot(process.cwd());
			if (root === undefined)
				log.fail(
					"No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })",
				);
			for (const warning of ignoredFlagWarnings(parsed.values))
				log.warn(warning);
			const { DETACH_TIMEOUT_MS, runDetached } = await import("../dev-detach");
			return runDetached({
				root,
				keep: parsed.values.keep,
				json: parsed.values.json,
				argv: process.argv,
				timeoutMs: DETACH_TIMEOUT_MS,
			});
		}
		// The runtime has to be known before the environment is built, so it is
		// read here rather than inside runCli, which is handed a finished env.
		const timer = timingRequested(parsed.values)
			? createPhaseTimer({ startedAt: 0, json: parsed.values["timing-json"] })
			: createNoopPhaseTimer();
		try {
			const env = await timer.measure("config and ports", async () =>
				(await import("../../loader")).loadDevEnv({
					containerRuntime: parsed.values.runtime,
				}),
			);
			await (await import("../run-cli")).runCli(env, { parsed, timer });
		} catch (error) {
			timer.report();
			throw error;
		}
		return 0;
	},
});
