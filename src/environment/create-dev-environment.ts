import { assertValidConfig } from "../config";
import { applyIntegrations } from "../config/integrations";
import { withDeadline } from "../core/deadline";
import { waitForServer } from "../core/network";
import { type PrimaryAppInput, resolvePrimaryApp } from "../core/primary-app";
import { stopProcess } from "../core/process";
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
import { createCaptureRecorder, labelledCaptures } from "./captures";
import { createDevEnvContext } from "./context";
import { createEnvVarsApi } from "./env-vars";
import { renderGeneratedFiles } from "./generated-files";
import { createLegacyLinks } from "./legacy-links";
import { createLifecycleApi } from "./lifecycle";
import { LifecycleCoordinator } from "./lifecycle-coordinator";
import { createRunClaimApi } from "./run-claim";
import { createServersApi } from "./servers";
import { registerStartPlanner } from "./start-plan";

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
	// Integrations transform the config before anything reads it; `withSuffix`
	// re-applies them to the original, which is pure and gives the same result.
	const resolved = applyIntegrations(config);
	assertValidConfig(resolved);

	const ctx = createDevEnvContext(resolved, options);
	const envVars = createEnvVarsApi(ctx);
	const runClaim = createRunClaimApi(ctx);
	const coordinator = new LifecycleCoordinator();
	const lifecycle = createLifecycleApi(ctx, envVars, runClaim, coordinator);
	const recordCapture = createCaptureRecorder(ctx, envVars);
	const servers = createServersApi(ctx, envVars);

	const { getExpoApiUrl, getFrontendPort } = createLegacyLinks(ctx);

	const env: DevEnvironment<TServices, TApps, TEnv> = {
		// Configuration access
		projectName: ctx.projectName,
		projectPrefix: resolved.projectPrefix,
		ports: ctx.ports,
		urls: ctx.urls,
		loopbackUrls: ctx.loopbackUrls,
		publicUrls: ctx.publicUrls as ComputedPublicUrls<TServices, TApps>,
		workspaceId: ctx.workspaceId,
		services: ctx.services,
		apps: ctx.apps,
		prepareStart: ctx.prepareStart,
		prepareStartAsync: ctx.prepareStartAsync,
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
		seed: resolved.seed
			? {
					command: resolved.seed.command,
					cwd: resolved.seed.cwd,
					beforeApps: resolved.seed.beforeApps,
					requiredServices: resolved.seed.requiredServices,
				}
			: undefined,
		checks: resolved.checks,
		preflight: resolved.preflight,
		secrets: resolved.secrets,
		integrations: resolved.integrations,
		generatedFiles: resolved.generatedFiles,
		captured: ctx.captured,
		recordCapture,
		renderGeneratedFiles: () => renderGeneratedFiles(ctx, envVars),
		details: () =>
			Object.assign(
				labelledCaptures(resolved.apps ?? {}, ctx.captured),
				...(resolved.integrations ?? []).map((integration) =>
					integration.describe?.(
						envVars.getHookContext() as unknown as Parameters<
							NonNullable<typeof integration.describe>
						>[0],
					),
				),
			),
		tasks: resolved.tasks,
		profiles: resolved.profiles,

		// Container management
		start: lifecycle.start,
		stop: lifecycle.stop,
		restart: lifecycle.restart,
		isRunning: lifecycle.isRunning,
		runSeed: lifecycle.runSeed,

		resolvePrimaryApp: (selected) =>
			resolvePrimaryApp({
				apps: ctx.apps,
				options: resolved.options as PrimaryAppInput["options"],
				selected,
			}) as Extract<keyof TApps, string> | undefined,

		// Server management
		startServers: (options = {}) =>
			coordinator.start(
				(signal) => servers.startServersOnly({ ...options, signal }),
				options.signal,
				(pids) => Object.keys(pids).length > 0,
			),
		runServerHook: async (phase, signal) => {
			const hook =
				resolved.hooks?.[phase === "before" ? "beforeServers" : "afterServers"];
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

	if (resolved.prisma) {
		(env as { prisma: PrismaRunner }).prisma = createPrismaRunner(
			env,
			resolved.prisma,
			(computed) => envVars.resolveSecrets(undefined, { computed }),
		);
	}

	registerStartPlanner(env, ctx.getStartPlan);
	return env;
}
