import { assertValidConfig } from "../config";
import { applyIntegrations } from "../config/integrations";
import { resolveConfig } from "../config/resolve";
import { labelledCaptures } from "../core/captured-values";
import { waitForDevServers, waitForServer } from "../core/network";
import { findMonorepoRoot } from "../core/ports";
import { resolvePrimaryApp } from "../core/primary-app";
import { createPrismaRunner } from "../prisma";
import type {
	AppConfig,
	AppEnvVars,
	ComputedEnvVars,
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
import { type AnyApps, type AnyServices, createDevEnvContext } from "./context";
import { createEnvVarsApi } from "./env-vars";
import { renderGeneratedFiles } from "./generated-files";
import { registerInternals } from "./internals";
import { createLifecycleApi } from "./lifecycle";
import { LifecycleCoordinator } from "./lifecycle-coordinator";
import { createAppPipeline } from "./pipeline";
import { createRunClaimApi } from "./run-claim";
import { createServerHookRunner, createServersApi } from "./servers";
import { createServiceWatch } from "./service-watch";

type EnvironmentOptions = {
	suffix?: string;
	containerRuntime?: string;
	root?: string;
} & SuffixedEnvironmentOptions;

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
	options: EnvironmentOptions = {},
): DevEnvironment<TServices, TApps, TEnv> {
	// The typed view, applied once: everything below reads the config with
	// its keys unknown, and builds the same object either way.
	return createEnvironment(
		config as DevConfig<AnyServices, AnyApps>,
		options,
	) as unknown as DevEnvironment<TServices, TApps, TEnv>;
}

function createEnvironment(
	config: DevConfig<AnyServices, AnyApps>,
	options: EnvironmentOptions,
): DevEnvironment<AnyServices, AnyApps> {
	// Integrations transform the config before anything reads it; `withSuffix`
	// re-applies them to the original, which is pure and gives the same result.
	// They read project files from the checkout, wherever this process runs.
	const root = options.root ?? findMonorepoRoot();
	const applied = applyIntegrations(config, { root });
	assertValidConfig(applied);
	const resolved: ResolvedDevConfig = resolveConfig(applied);

	const ctx = createDevEnvContext(resolved, { ...options, root });
	const envVars = createEnvVarsApi(ctx);
	// The entry an app run publishes is built from the environment itself.
	const runClaim = createRunClaimApi(ctx, () => env);
	const coordinator = new LifecycleCoordinator();
	const serviceWatch = createServiceWatch(ctx, runClaim.sessionId);
	const recordCapture = createCaptureRecorder(ctx, envVars);
	const appPipeline = createAppPipeline({
		root: ctx.root,
		ports: ctx.ports,
		projectName: ctx.projectName,
		unsetEnv: resolved.unsetEnv,
		runtime: () => ctx.runtime,
		appEnv: (name, production) => envVars.buildAppEnvVars(name, production),
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

	const env: DevEnvironment<AnyServices, AnyApps> = {
		// Configuration access
		projectName: ctx.projectName,
		projectPrefix: resolved.projectPrefix,
		ports: ctx.ports,
		urls: ctx.urls,
		loopbackUrls: ctx.loopbackUrls,
		publicUrls: ctx.publicUrls,
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
		secrets: resolved.secrets,
		integrations: resolved.integrations,
		generatedFiles: resolved.generatedFiles,
		checkoutFiles: resolved.options?.checkoutFiles,
		captured: ctx.captured,
		details: () =>
			Object.assign(
				labelledCaptures(resolved.apps ?? {}, ctx.captured),
				...(resolved.integrations ?? []).map((integration) =>
					integration.describe?.(envVars.getHookContext()),
				),
			),
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
				options: resolved.options,
				selected,
			}),

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
		// Every computed name is set, which the env's record type cannot say.
		buildEnvVars: (production) =>
			envVars.buildEnvVars(production) as ComputedEnvVars<AnyServices, AnyApps>,
		buildAppEnvVars: <TName extends string>(
			name: TName,
			production?: boolean,
		) =>
			envVars.buildAppEnvVars(name, production) as AppEnvVars<
				AnyServices,
				AnyApps,
				EnvValues,
				TName
			>,
		buildEnvFingerprint: envVars.buildEnvFingerprint,
		setPublicUrls: ctx.setPublicUrls,
		clearPublicUrls: ctx.clearPublicUrls,
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
			createEnvironment(config, {
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
		tasks: resolved.tasks,
		setNamedHostsActive: ctx.setNamedHostsActive,
		ensureComposeFile: ctx.ensureComposeFile,
		composeModel: ctx.composeModel,
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
			ctx,
		);
	}

	return env;
}
