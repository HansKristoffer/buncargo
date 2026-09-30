import { withDeadline } from "../core/deadline";
import {
	type StartDevServersOptions,
	startDevServers,
} from "../core/process/dev-servers";
import type { CapturedValue } from "../core/process/output-capture";
import type { AppConfig, DevServerPids } from "../types";

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
}

type ServerSessionOptions = Omit<StartDevServersOptions, "onCapture"> & {
	onCapture?: (app: string, captured: CapturedValue) => void | Promise<void>;
};

export async function startServerSession(
	source: ServerSessionSource,
	apps: Record<string, AppConfig>,
	options: ServerSessionOptions,
): Promise<DevServerPids> {
	await withDeadline(
		(signal) => source.runHook("before", signal),
		600_000,
		options.signal,
	);
	return startDevServers(apps, source.root, source.appEnv, source.ports, {
		...options,
		waitForHealth: async (wave, signal) => {
			await source.waitForHealth(wave, signal);
			await options.waitForHealth?.(wave, signal);
		},
		onReady: async (signal) => {
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
	});
}
