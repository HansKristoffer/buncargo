import {
	spawnWatchdog as spawnWatchdogFn,
	startHeartbeat as startHeartbeatFn,
	stopHeartbeat as stopHeartbeatFn,
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
	return {
		startHeartbeat(intervalMs) {
			startHeartbeatFn(ctx.projectName, intervalMs, ctx.root);
		},
		stopHeartbeat() {
			stopHeartbeatFn();
		},
		async spawnWatchdog(timeoutMinutes) {
			await spawnWatchdogFn(ctx.projectName, ctx.root, {
				timeoutMinutes,
				verbose: true,
				composeFile: ctx.composeFile,
			});
		},
		stopWatchdog() {
			stopWatchdogFn(ctx.projectName, ctx.root);
		},
	};
}
