import { assertValidConfig } from "../config";
import { applyIntegrations } from "../config/integrations";
import { resolveConfig } from "../config/resolve";
import { labelledCaptures } from "../core/captured-values";
import { waitForDevServers, waitForServer } from "../core/network";
import { findMonorepoRoot } from "../core/ports";
import { type PrimaryAppInput, resolvePrimaryApp } from "../core/primary-app";
import { createPrismaRunner } from "../prisma";
import type {
	AppConfig,
	ComputedPublicUrls,
	DevConfig,
	DevEnvironment,
	EnvValues,
	PrismaRunner,
	ResolvedDevConfig,
	ServiceConfig,
	SuffixedEnvironmentOptions,
} from "../types";
import { createCaptureRecorder } from "./captures";
import { explainMissingContainers, withLossNotice } from "./container-loss";
import { createDevEnvContext } from "./context";
import { createEnvVarsApi } from "./env-vars";
import { renderGeneratedFiles } from "./generated-files";
import { registerInternals } from "./internals";
import { createLifecycleApi } from "./lifecycle";
import { LifecycleCoordinator } from "./lifecycle-coordinator";
import { createAppPipeline } from "./pipeline";
import { createRunClaimApi } from "./run-claim";
import { createServerHookRunner, createServersApi } from "./servers";
import { createServiceWatch } from "./service-watch";

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
	} & SuffixedEnvironmentOptions = {},
): DevEnvironment<TServices, TApps, TEnv> {
	// Integrations transform the config before anything reads it; `withSuffix`
	// re-applies them to the original, which is pure and gives the same result.
	// They read project files from the checkout, wherever this process runs.
	const root = options.root ?? findMonorepoRoot();
	const applied = applyIntegrations(config, { root });
	assertValidConfig(applied);
	const resolved = resolveConfig(applied) as ResolvedDevConfig<
		TServices,
		TApps,
		TEnv
	>;

	const ctx = createDevEnvContext(resolved, { ...options, root });
	const envVars = createEnvVarsApi(ctx);
	// The entry an app run publishes is built from the environment itself.
	const runClaim = createRunClaimApi(ctx, () => env);
	const coordinator = new LifecycleCoordinator();
	const serviceWatch = createServiceWatch(ctx, runClaim.sessionId);
	const recordCapture = createCaptureRecorder(ctx, envVars);
	const appPipeline = createAppPipeline({
		root: ctx.root,
		ports: ctx.ports as Record<string, number>,
		projectName: ctx.projectName,
		unsetEnv: resolved.unsetEnv,
		runtime: () => ctx.runtime,
		appEnv: (name, production) =>
			envVars.buildAppEnvVars(name as Extract<keyof TApps, string>, production),
		runHook: createServerHookRunner(ctx, envVars),
		waitForHealth: (apps, productionBuild, signal) =>
			withLossNotice(missingContainers, () =>
				waitForDevServers(apps, ctx.ports, {
					verbose: false,
					logReady: false,
					productionBuild,
					signal,
				}),
			),
		recordCapture,
		renderGeneratedFiles: () => renderGeneratedFiles(ctx, envVars),
		runSeed: (options) => lifecycle.runSeed(options),
		claim: runClaim,
		ensureWatchdog: () => lifecycle.ensureWatchdog(),
		ownedServerPids: ctx.ownedServerPids,
	});
	const lifecycle = createLifecycleApi(
		ctx,
		envVars,
		runClaim,
		coordinator,
		serviceWatch,
		appPipeline,
	);
	const servers = createServersApi(ctx, appPipeline);
	const createdAt = Date.now();
	const missingContainers = () =>
		explainMissingContainers(ctx, runClaim.claimedAt ?? createdAt);

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
		planPortOffset: ctx.planPortOffset,
		prepareStartAsync: ctx.prepareStartAsync,
		get portOffset() {
			return ctx.portOffset;
		},
		get portOffsetProvenance() {
			return ctx.portOffsetProvenance;
		},
		isWorktree: ctx.worktree,
		worktreeIsolation: resolved.options?.worktreeIsolation !== false,
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
		setupChecks: resolved.setupChecks,
		preflight: resolved.preflight,
		secrets: resolved.secrets,
		integrations: resolved.integrations,
		generatedFiles: resolved.generatedFiles,
		checkoutFiles: resolved.options?.checkoutFiles,
		captured: ctx.captured,
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
		onAppFailure: resolved.options?.onAppFailure,

		// Container management
		start: lifecycle.start,
		stop: lifecycle.stop,
		withServices: lifecycle.withServices,
		isRunning: lifecycle.isRunning,
		explainMissingContainers: missingContainers,
		runSeed: lifecycle.runSeed,

		resolvePrimaryApp: (selected) =>
			resolvePrimaryApp({
				apps: ctx.apps,
				options: resolved.options as PrimaryAppInput["options"],
				selected,
			}) as Extract<keyof TApps, string> | undefined,

		// Server management
		startServers: (options = {}) =>
			withLossNotice(missingContainers, () =>
				coordinator.start(
					(signal) => servers.startServersOnly({ ...options, signal }),
					options.signal,
					(pids) => Object.keys(pids).length > 0,
				),
			),
		waitForServers: (options = {}) =>
			withLossNotice(missingContainers, () =>
				servers.waitForServersReady(options),
			),

		// Utilities
		buildEnvVars: envVars.buildEnvVars,
		buildAppEnvVars: envVars.buildAppEnvVars,
		buildEnvFingerprint: envVars.buildEnvFingerprint,
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

		// Run claim / watchdog
		sessionId: runClaim.sessionId,
		claimRun: runClaim.claimRun,
		releaseRun: () => {
			// Released containers are the idle hold's: whatever stops them next
			// is no news for this run.
			serviceWatch.stop();
			return runClaim.releaseRun();
		},
		ensureWatchdog: runClaim.ensureWatchdog,

		// Prisma (created below if configured)
		prisma: undefined,

		// Advanced
		withSuffix: (newSuffix, suffixed) =>
			createDevEnvironment(config, {
				...options,
				suffix: newSuffix,
				data: suffixed?.data,
			}),
	};

	registerInternals(env, {
		prepare: lifecycle.prepare,
		secretsSession: lifecycle.secretsSession,
		claimApps: appPipeline.claimApps,
		spawn: appPipeline.spawn,
		notify: serviceWatch.report,
		renderGeneratedFiles: () => renderGeneratedFiles(ctx, envVars),
		recordCapture,
	});

	if (resolved.prisma) {
		(env as { prisma: PrismaRunner }).prisma = createPrismaRunner(
			env,
			resolved.prisma,
			(computed) => envVars.resolveSecrets(undefined, { computed }),
			// An allocation already made stands: probing again would move the
			// block under the run that made it and replace its selection.
			(service) =>
				ctx.selection
					? Promise.resolve()
					: ctx.prepareStartAsync(undefined, [service]),
			lifecycle.readied,
		);
	}

	return env;
}
