import {
	createHeartbeatOwner,
	spawnWatchdog as spawnWatchdogFn,
	stopWatchdog as stopWatchdogFn,
} from "../core/watchdog";
import type { AppConfig, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";

export interface DevWatchdogApi {
	startHeartbeat(intervalMs?: number): void;
	stopHeartbeat(): void;
	spawnWatchdog(timeoutMinutes?: number): Promise<void>;
	stopWatchdog(): void;
}

export function createWatchdogApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(ctx: DevEnvContext<TServices, TApps>): DevWatchdogApi {
	const heartbeat = createHeartbeatOwner(ctx.projectName, ctx.root);
	return {
		startHeartbeat(intervalMs) {
			heartbeat.start(intervalMs);
		},
		stopHeartbeat() {
			heartbeat.stop();
		},
		async spawnWatchdog(timeoutMinutes) {
			await spawnWatchdogFn(ctx.projectName, ctx.root, {
				timeoutMinutes,
				verbose: true,
				composeFile: ctx.composeFile,
				containerRuntime: ctx.runtime.name,
				containerRuntimeBinary: ctx.runtimeBinary,
			});
		},
		stopWatchdog() {
			stopWatchdogFn(ctx.projectName, ctx.root);
		},
	};
}
