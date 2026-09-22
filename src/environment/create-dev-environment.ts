import { assertValidConfig } from "../config";
import { withDeadline } from "../core/deadline";
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
import { createRunClaimApi } from "./run-claim";
import { createServersApi } from "./servers";

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
	options: {
		suffix?: string;
		containerRuntime?: string;
		root?: string;
		readOnly?: boolean;
	} = {},
): DevEnvironment<TServices, TApps, TEnv> {
	assertValidConfig(config);

	const ctx = createDevEnvContext(config, options);
	const envVars = createEnvVarsApi(ctx);
	const runClaim = createRunClaimApi(ctx);
	const lifecycle = createLifecycleApi(ctx, envVars, runClaim);
	const servers = createServersApi(ctx, envVars);

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
		workspaceId: ctx.workspaceId,
		services: ctx.services,
		apps: ctx.apps,
		prepareStart: ctx.prepareStart,
		get portOffset() {
			return ctx.portOffset;
		},
		get portOffsetProvenance() {
			return ctx.portOffsetProvenance;
		},
		isWorktree: ctx.worktree,
		localIp: ctx.localIp,
		root: ctx.root,
		composeFile: ctx.composeFile,
		get containerRuntime() {
			return ctx.runtime.name;
		},
		get containerRuntimeBinary() {
			return ctx.runtimeBinary;
		},
		hosts: ctx.hosts,
		setNamedHostsActive: (active, extras) => {
			ctx.setNamedHostsActive(active, extras);
		},
		seed: config.seed
			? { command: config.seed.command, cwd: config.seed.cwd }
			: undefined,

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
		runServerHook: async (phase, signal) => {
			const hook =
				config.hooks?.[phase === "before" ? "beforeServers" : "afterServers"];
			if (hook)
				await withDeadline(
					(hookSignal) => hook(envVars.getHookContext(hookSignal)),
					600000,
					signal,
				);
		},
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

		// Run claim / watchdog
		sessionId: runClaim.sessionId,
		claimRun: runClaim.claimRun,
		releaseRun: runClaim.releaseRun,
		ensureWatchdog: runClaim.ensureWatchdog,

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
