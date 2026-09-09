import { tailscaleAuthKey } from "../core/runtime-flags";
import { tailscaleBinary } from "../core/tailnet/client";
import { ensureTailnetCoordinator } from "../core/tailnet/launcher";
import type { AppConfig, ServiceConfig } from "../types";
import * as log from "./log";

/** Sharing consumes the run registry; it does not maintain another copy of app lifecycle state. */
export function createDevTailnet() {
	if (!tailscaleAuthKey() && !tailscaleBinary()) return;
	const controller = new AbortController();
	let count = 0;
	let task: Promise<void> | undefined;
	return {
		plan(
			apps: Record<string, AppConfig>,
			names: readonly string[],
			services: Record<string, ServiceConfig>,
		) {
			count =
				Object.values(apps).filter((a) => a.kind !== "worker").length +
				names.filter(
					(name) =>
						services[name]?.kind !== "job" &&
						services[name]?.port !== undefined,
				).length;
		},
		get active() {
			return count > 0;
		},
		start() {
			if (!count || task) return;
			task = ensureTailnetCoordinator(controller.signal)
				.then(() => {
					log.info(`Sharing ${count} targets through Tailscale`);
				})
				.catch((error) => {
					if (!controller.signal.aborted)
						log.warn(
							`Tailscale sharing unavailable: ${error instanceof Error ? error.message : "check Tailscale status"}`,
						);
				});
		},
		async stop() {
			controller.abort();
			await task;
		},
	};
}
export type DevTailnet = NonNullable<ReturnType<typeof createDevTailnet>>;
