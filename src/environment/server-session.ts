import { anySignal } from "hanzio";
import { ReactiveTaskRunner } from "../core/process";
import {
	type AfterAppsTask,
	loadStartSecrets,
	type StartDevServersOptions,
	startableApps,
	startDevServers,
} from "../core/process/dev-servers";
import type { CapturedValue } from "../core/process/output-capture";
import { printStream, RunOutput } from "../core/process/run-output";
import { prefixWidth } from "../core/style";
import type { ResolvedApp, SeedOutcome } from "../types";
import { assertSeedSucceeded } from "./seed-startup";

/** Shared lifecycle; callers supply UI, registry and tunnel observers. */
export interface ServerSessionSource {
	root: string;
	ports: Record<string, number>;
	appEnv(name: string): Record<string, string>;
	/** `beforeServers`/`afterServers`/`afterServersStop`; bounds its own wait. Returns whether a hook ran. */
	runHook(
		phase: "before" | "after" | "afterStop",
		signal?: AbortSignal,
	): Promise<boolean>;
	/** Integration post-readiness hook for one app, before downstream waves proceed. */
	onAppReady?(name: string, signal?: AbortSignal): Promise<void>;
	/** Calls `onAppReady` as each app comes up, before the whole set is. */
	waitForHealth(
		apps: Record<string, ResolvedApp>,
		signal?: AbortSignal,
		onAppReady?: (name: string) => void,
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

type ServerSessionOptions = Omit<
	StartDevServersOptions,
	"onCapture" | "afterAppsTask"
> & {
	onCapture?: (app: string, captured: CapturedValue) => void | Promise<void>;
	seed?: (signal: AbortSignal) => Promise<SeedOutcome>;
	/** Post-app seed run once `apps` are ready (`seed.afterApps`). */
	afterAppsSeed?: {
		apps: readonly string[];
		beforeOtherApps: boolean;
		run: (signal: AbortSignal) => Promise<SeedOutcome>;
	};
	/** Keep an empty session alive for tunnels or remote sharing. */
	stayOpen?: (signal: AbortSignal) => Promise<void>;
};

export async function startServerSession(
	source: ServerSessionSource,
	apps: Record<string, ResolvedApp>,
	options: ServerSessionOptions,
): Promise<Record<string, number>> {
	options.signal?.throwIfAborted();

	const seed = options.seed
		? startSeedTask(options.seed, options.signal)
		: undefined;

	// A failing seed aborts this signal, which stops the secrets, `prepare` and the apps.
	const signal = seed?.signal ?? options.signal ?? new AbortController().signal;
	const joinSeed = async () => {
		await seed?.ready;
		if (seed) source.onSeedReady?.();
	};

	try {
		// A missing required secret refuses before a production build or
		// `beforeServers` runs; `startDevServers` checks again from the cache.
		await loadStartSecrets(
			startableApps(apps, options.productionBuild ?? false),
			source.appEnv,
			{ signal, onWait: (ms) => options.onPhase?.("secrets", ms) },
		);
		await source.prepare?.(signal);

		if (Object.keys(apps).length === 0 && options.stayOpen) {
			await joinSeed();
			if (options.afterAppsSeed) {
				assertSeedSucceeded(await options.afterAppsSeed.run(signal));
				if (!options.afterAppsSeed.beforeOtherApps) source.onSeedReady?.();
			}
			const reactiveInput = options.reactiveTasks || undefined;
			const hasReactive =
				reactiveInput !== undefined &&
				Object.keys(reactiveInput.tasks).length > 0;
			const holdController = new AbortController();
			const holdSignal = anySignal(signal, holdController.signal);
			const ownOutput =
				hasReactive && !options.output
					? new RunOutput({ terminals: "pipe" })
					: undefined;
			const stopPrint =
				ownOutput && reactiveInput
					? printStream(ownOutput, {
							width: prefixWidth(Object.keys(reactiveInput.tasks)),
						})
					: undefined;
			const taskOutput = options.output ?? ownOutput;
			const reactive =
				hasReactive && reactiveInput && taskOutput
					? new ReactiveTaskRunner({
							root: source.root,
							apps: reactiveInput.apps ?? apps,
							tasks: reactiveInput.tasks,
							buildEnv: reactiveInput.buildEnv,
							output: taskOutput,
							signal: holdSignal,
							watch: options.watch,
							initialReadyApps: reactiveInput.initialReadyApps,
							unsetEnv: options.unsetEnv,
							shutdownGraceMs: options.shutdownGraceMs,
						})
					: undefined;
			if (reactive && taskOutput) {
				taskOutput.controls = {
					restart: (name) =>
						Promise.resolve(reactive.trigger(name, "requested")),
				};
				reactive.arm();
			}
			try {
				await options.onReady?.(signal);
				await options.stayOpen(signal);
				return {};
			} finally {
				holdController.abort();
				await reactive?.stop();
				if (ownOutput) {
					await ownOutput.close();
					ownOutput.dispose();
					stopPrint?.();
				}
			}
		}

		let serversStarted = false;
		try {
			const beforeHookRan = await source.runHook("before", signal);
			const freshPortOwners =
				!beforeHookRan && !options.productionBuild
					? options.initialPortOwners
					: undefined;
			const { afterAppsSeed, ...devServerOptions } = options;
			const afterAppsTask: AfterAppsTask | undefined = afterAppsSeed
				? {
						label: "seed",
						apps: afterAppsSeed.apps,
						beforeOtherApps: afterAppsSeed.beforeOtherApps,
						run: async (taskSignal) => {
							assertSeedSucceeded(await afterAppsSeed.run(taskSignal));
						},
					}
				: undefined;
			const pids = await startDevServers(
				apps,
				source.root,
				source.appEnv,
				source.ports,
				{
					...devServerOptions,
					initialPortOwners: freshPortOwners,
					signal,
					afterAppsTask,
					onAppReady: async (name, appSignal) => {
						await source.onAppReady?.(name, appSignal);
						await options.onAppReady?.(name, appSignal);
					},
					waitForHealth: async (wave, signal, onAppReady) => {
						await source.waitForHealth(wave, signal, onAppReady);
						await options.waitForHealth?.(wave, signal, onAppReady);
					},
					onReady: async (signal) => {
						await joinSeed();
						if (afterAppsSeed && !afterAppsSeed.beforeOtherApps) {
							source.onSeedReady?.();
						}
						await source.runHook("after", signal);
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
			serversStarted = true;
			return pids;
		} finally {
			// Run ephemeral cleanup when a supervised session ends or startup fails
			// (even if `beforeServers` threw partway after writing temporary files).
			// Handed-off library `start()` calls run `afterServersStop` inside `stop()`.
			if (options.waitForExit || !serversStarted) {
				await source.runHook("afterStop").catch(() => {});
			}
		}
	} finally {
		// A start that failed stops a seed still running and waits for it to
		// end; a start that succeeded has joined the seed already.
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
	const signal = anySignal(parent, controller.signal);
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
