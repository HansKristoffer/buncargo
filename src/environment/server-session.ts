import { withDeadline } from "../core/deadline";
import {
	type StartDevServersOptions,
	startDevServers,
} from "../core/process/dev-servers";
import type { CapturedValue } from "../core/process/output-capture";
import type { AppConfig, DevServerPids, SeedOutcome } from "../types";
import { assertSeedSucceeded } from "./seed-startup";

/** Shared lifecycle; callers supply UI, registry and tunnel observers. */
export interface ServerSessionSource {
	root: string;
	ports: Record<string, number>;
	appEnv(name: string): Record<string, string>;
	runHook(phase: "before" | "after", signal?: AbortSignal): Promise<void>;
	waitForHealth(
		apps: Record<string, AppConfig>,
		signal?: AbortSignal,
	): Promise<void>;
	recordCapture(
		app: string,
		captured: CapturedValue,
	): Promise<readonly string[]>;
	afterWave?(): void;
	/** Builds or tunnel preparation share the seed's cancellation lifetime. */
	prepare?(signal: AbortSignal): Promise<void>;
	onSeedReady?(): void;
}

type ServerSessionOptions = Omit<StartDevServersOptions, "onCapture"> & {
	onCapture?: (app: string, captured: CapturedValue) => void | Promise<void>;
	seed?: (signal: AbortSignal) => Promise<SeedOutcome>;
	/** Keep an empty session alive for tunnels or remote sharing. */
	stayOpen?: (signal: AbortSignal) => Promise<void>;
};

export async function startServerSession(
	source: ServerSessionSource,
	apps: Record<string, AppConfig>,
	options: ServerSessionOptions,
): Promise<DevServerPids> {
	options.signal?.throwIfAborted();
	const seed = options.seed
		? startSeedTask(options.seed, options.signal)
		: undefined;
	const signal = seed?.signal ?? options.signal ?? new AbortController().signal;
	const joinSeed = async () => {
		await seed?.ready;
		if (seed) source.onSeedReady?.();
	};
	try {
		await source.prepare?.(signal);
		if (Object.keys(apps).length === 0 && options.stayOpen) {
			await joinSeed();
			await options.onReady?.(signal);
			await options.stayOpen?.(signal);
			return {};
		}
		await withDeadline(
			(signal) => source.runHook("before", signal),
			600_000,
			signal,
		);
		return await startDevServers(
			apps,
			source.root,
			source.appEnv,
			source.ports,
			{
				...options,
				signal,
				waitForHealth: async (wave, signal) => {
					await source.waitForHealth(wave, signal);
					await options.waitForHealth?.(wave, signal);
				},
				onReady: async (signal) => {
					await joinSeed();
					await withDeadline(
						(hookSignal) => source.runHook("after", hookSignal),
						600_000,
						signal,
					);
					await options.onReady?.(signal);
				},
				onAfterWave1: async (signal) => {
					await options.onAfterWave1?.(signal);
					source.afterWave?.();
				},
				onCapture: async (app, captured) => {
					const changed = await source.recordCapture(app, captured);
					await options.onCapture?.(app, captured);
					return changed;
				},
			},
		);
	} finally {
		seed?.cancel();
		if (seed) await Promise.allSettled([seed.ready]);
	}
}

/** The session owns cancellation and draining; successful startup hands off apps. */
function startSeedTask(
	run: (signal: AbortSignal) => Promise<SeedOutcome>,
	parent?: AbortSignal,
) {
	const controller = new AbortController();
	const signal = parent
		? AbortSignal.any([parent, controller.signal])
		: controller.signal;
	let settled = false;
	const ready = Promise.resolve()
		.then(() => run(signal))
		.then(assertSeedSucceeded)
		.catch((error) => {
			controller.abort(error);
			throw error;
		})
		.finally(() => {
			settled = true;
		});
	void ready.catch(() => {});
	return {
		ready,
		signal,
		cancel: (error?: unknown) => {
			if (!settled) controller.abort(error);
		},
	};
}
