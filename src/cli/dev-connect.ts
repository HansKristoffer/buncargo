import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { newCredential } from "../core/connect/client";
import { intentsPath } from "../core/connect/daemon";
import { ensureConnectCoordinator } from "../core/connect/launcher";
import { writeJsonDocument } from "../core/registry-file";
import {
	connectName,
	connectOrigin,
	connectTokens,
} from "../core/runtime-flags";
import type { AppConfig, ServiceConfig } from "../types";
import * as log from "./log";
/** Registration intent belongs to this invocation; the run registry owns target lifetime. */
export function createDevConnect() {
	const tokens = connectTokens();
	if (!tokens.length) return;
	const name = connectName() ?? hostname(),
		origin = connectOrigin(),
		controller = new AbortController();
	let count = 0,
		path: string | undefined,
		task: Promise<void> | undefined;
	return {
		plan(
			apps: Record<string, AppConfig>,
			names: readonly string[],
			services: Record<string, ServiceConfig>,
		) {
			count =
				Object.values(apps).filter((a) => a.kind !== "worker").length +
				names.filter(
					(n) => services[n]?.kind !== "job" && services[n]?.port !== undefined,
				).length;
		},
		get active() {
			return count > 0;
		},
		start(sessionId: string) {
			if (!count || task) return;
			path = `${intentsPath()}/${sessionId}.json`;
			task = writeJsonDocument(path, {
				sessionId,
				tokens,
				name,
				origin,
				credential: newCredential("pub"),
			})
				.then(() => ensureConnectCoordinator(controller.signal))
				.then(() =>
					log.info(
						`Connecting ${count} targets for ${tokens.length} recipient(s)`,
					),
				)
				.catch((error) => {
					if (!controller.signal.aborted)
						log.warn(
							`Remote sharing unavailable: ${error instanceof Error ? error.message : "run buncargo connect status"}`,
						);
				});
		},
		async stop() {
			controller.abort();
			await task;
			if (path) await rm(path, { force: true });
		},
	};
}
export type DevConnect = NonNullable<ReturnType<typeof createDevConnect>>;
