import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { getErrorMessage } from "hanzio";
import { intentsPath } from "../core/connect/coordinator-state";
import { newCredential } from "../core/connect/credentials";
import { ensureConnectCoordinator } from "../core/connect/launcher";
import { abortableSleep } from "../core/deadline";
import { writeJsonDocument } from "../core/registry-file";
import {
	connectName,
	connectOrigin,
	connectTokens,
} from "../core/runtime-flags";
import type { ResolvedApp, ResolvedService } from "../types";
import * as log from "./log";

/**
 * How often a run ensures its coordinator. One that exited (killed, crashed,
 * or replaced by a newer build's run) stops sharing this run's targets until
 * a launcher starts another.
 */
const COORDINATOR_ENSURE_MS = 10_000;

/**
 * Ensure the coordinator now and every `intervalMs` until `signal` aborts.
 * `onReady` follows the first ensure that succeeds. A failing ensure warns
 * once, and again only after one has succeeded in between.
 */
export async function keepCoordinator(input: {
	ensure: (signal: AbortSignal) => Promise<void>;
	intervalMs: number;
	signal: AbortSignal;
	onReady: () => void;
	warn: (reason: string) => void;
}): Promise<void> {
	const { signal } = input;
	let ready = false;
	let warned = false;
	while (!signal.aborted) {
		try {
			await input.ensure(signal);
			if (!ready) input.onReady();
			ready = true;
			warned = false;
		} catch (error) {
			if (signal.aborted) return;
			if (!warned)
				input.warn(getErrorMessage(error, "run buncargo connect status"));
			warned = true;
		}

		try {
			await abortableSleep(input.intervalMs, signal);
		} catch {
			return;
		}
	}
}

/** Registration intent belongs to this invocation; the run registry owns target lifetime. */
export function createDevConnect() {
	const tokens = connectTokens();
	if (!tokens.length) {
		return;
	}
	const name = connectName() ?? hostname();
	const origin = connectOrigin();
	const controller = new AbortController();
	let count = 0;
	let path: string | undefined;
	let task: Promise<void> | undefined;

	return {
		plan(
			apps: Record<string, ResolvedApp>,
			names: readonly string[],
			services: Record<string, ResolvedService>,
		) {
			count =
				Object.values(apps).filter((a) => a.port !== undefined).length +
				names.filter((n) => services[n]?.port !== undefined).length;
		},
		get active() {
			return count > 0;
		},
		start(sessionId: string) {
			if (!count || task) {
				return;
			}
			path = `${intentsPath()}/${sessionId}.json`;
			task = writeJsonDocument(path, {
				sessionId,
				tokens,
				name,
				origin,
				credential: newCredential("pub"),
			})
				.then(() =>
					keepCoordinator({
						ensure: ensureConnectCoordinator,
						intervalMs: COORDINATOR_ENSURE_MS,
						signal: controller.signal,
						onReady: () =>
							log.info(
								`Connecting ${count} targets for ${tokens.length} recipient(s)`,
							),
						warn: (reason) => log.warn(`Remote sharing unavailable: ${reason}`),
					}),
				)
				.catch((error) => {
					if (controller.signal.aborted) return;
					const reason = getErrorMessage(error, "run buncargo connect status");
					log.warn(`Remote sharing unavailable: ${reason}`);
				});
		},
		async stop() {
			controller.abort();
			await task;
			if (path) {
				await rm(path, { force: true });
			}
		},
	};
}

export type DevConnect = NonNullable<ReturnType<typeof createDevConnect>>;
