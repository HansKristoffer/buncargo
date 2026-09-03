import { assertValidConfig } from "../config";
import { waitForServer } from "../core/network";
import { toPortMap } from "../core/ports";
import {
	configuredPrimaryApp,
	type PrimaryAppInput,
	resolvePrimaryApp,
} from "../core/primary-app";
import { stopProcess } from "../core/process";
import { logExpoApiUrl, logFrontendPort } from "../core/utils";
import { createPrismaRunner } from "../prisma";
import type {
	AppConfig,
	ComputedPublicUrls,
	DevConfig,
	DevEnvironment,
	EnvValues,
	PrismaRunner,
	ServiceConfig,
} from "../types";
import { createDevEnvContext } from "./context";
import { createEnvVarsApi } from "./env-vars";
import { createLifecycleApi } from "./lifecycle";
import { createServersApi } from "./servers";
import { createWatchdogApi } from "./watchdog";

/**
 * Create a dev environment from a configuration.
 *
 * @example
 * ```typescript
 * import { defineDevConfig, createDevEnvironment } from 'buncargo'
 *
 * const config = defineDevConfig({
 *   projectPrefix: 'myapp',
 *   services: { postgres: { port: 5432 } },
 *   apps: { api: { port: 3000, devCommand: 'bun run dev' } }
 * })
 *
 * export const dev = createDevEnvironment(config)
 *
 * // Usage
 * await dev.start()
 * ```
 */
export function createDevEnvironment<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	config: DevConfig<TServices, TApps, TEnv>,
	options: { suffix?: string; containerRuntime?: string } = {},
): DevEnvironment<TServices, TApps, TEnv> {
	assertValidConfig(config);

	const ctx = createDevEnvContext(config, options);
	const envVars = createEnvVarsApi(ctx);
	const lifecycle = createLifecycleApi(ctx, envVars);
	const servers = createServersApi(ctx, envVars);
	const watchdog = createWatchdogApi(ctx);

	function getExpoApiUrl(): string {
		const appName = config.options?.expoApiApp ?? "api";
		const apiPort = toPortMap(ctx.ports)[appName];
		const url = `http://${ctx.localIp}:${apiPort}`;
		logExpoApiUrl(url);
		return url;
	}

	function getFrontendPort(): number | undefined {
		// `frontendApp` first: it is the narrower knob, and a project that set
		// both means the frontend is not the primary app.
		const configured =
			config.options?.frontendApp ??
			configuredPrimaryApp(config.options as PrimaryAppInput["options"]);
		const portMap = toPortMap(ctx.ports);
		const port =
			(configured ? portMap[configured] : undefined) ??
			portMap.platform ??
			portMap.web;
		logFrontendPort(port);
		return port;
	}

	const env: DevEnvironment<TServices, TApps, TEnv> = {
		// Configuration access
		projectName: ctx.projectName,
		projectPrefix: config.projectPrefix,
		ports: ctx.ports,
		urls: ctx.urls,
		loopbackUrls: ctx.loopbackUrls,
		publicUrls: ctx.publicUrls as ComputedPublicUrls<TServices, TApps>,
		services: ctx.services,
		apps: ctx.apps,
		portOffset: ctx.portOffset,
		portOffsetProvenance: ctx.portOffsetProvenance,
		isWorktree: ctx.worktree,
		localIp: ctx.localIp,
		root: ctx.root,
		composeFile: ctx.composeFile,
		containerRuntime: ctx.runtime.name,
		containerRuntimeBinary: ctx.runtimeBinary,
		hosts: ctx.hosts,
		setNamedHostsActive: (active, extras) => {
			ctx.setNamedHostsActive(active, extras);
		},
		seed: config.seed
			? { command: config.seed.command, cwd: config.seed.cwd }
			: undefined,
		autoShutdown: config.options?.autoShutdown,

		// Container management
		start: lifecycle.start,
		stop: lifecycle.stop,
		restart: lifecycle.restart,
		isRunning: lifecycle.isRunning,
		runSeed: lifecycle.runSeed,

		resolvePrimaryApp: (selected) =>
			resolvePrimaryApp({
				apps: ctx.apps,
				options: config.options as PrimaryAppInput["options"],
				selected,
			}) as Extract<keyof TApps, string> | undefined,

		// Server management
		startServers: servers.startServersOnly,
		stopProcess,
		waitForServers: servers.waitForServersReady,

		// Utilities
		buildEnvVars: envVars.buildEnvVars,
		buildAppEnvVars: envVars.buildAppEnvVars,
		setPublicUrls: ctx.setPublicUrls,
		clearPublicUrls: ctx.clearPublicUrls,
		ensureComposeFile: ctx.ensureComposeFile,
		composeModel: ctx.composeModel,
		exec: envVars.exec,
		waitForServer: async (url, timeout) => {
			await waitForServer(url, { timeout });
		},
		logInfo: ctx.logInfo,
		openPublicTunnels: servers.openPublicTunnels,

		// Vibe Kanban Integration
		getExpoApiUrl,
		getFrontendPort,

		// Watchdog / Heartbeat
		startHeartbeat: watchdog.startHeartbeat,
		stopHeartbeat: watchdog.stopHeartbeat,
		spawnWatchdog: watchdog.spawnWatchdog,
		stopWatchdog: watchdog.stopWatchdog,

		// Prisma (created below if configured)
		prisma: undefined,

		// Advanced
		withSuffix: (newSuffix) =>
			createDevEnvironment(config, {
				...options,
				suffix: newSuffix,
			}),
	};

	if (config.prisma) {
		(env as { prisma: PrismaRunner }).prisma = createPrismaRunner(
			env,
			config.prisma,
		);
	}

	return env;
}
