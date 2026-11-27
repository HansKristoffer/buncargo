import { assertValidConfig } from "../config";
import {
	applyIntegrations,
	applyProfileIntegrations,
} from "../config/integrations";
import { resolveConfig } from "../config/resolve";
import { validateProfileAppRefs } from "../config/validation/references";
import { labelledCaptures } from "../core/captured-values";
import { waitForDevServers, waitForServer } from "../core/network";
import { findMonorepoRoot } from "../core/ports";
import { resolvePrimaryApp } from "../core/primary-app";
import {
	applyInfisicalProjectConfig,
	readInfisicalProjectId,
} from "../core/secrets/index";
import { createPrismaRunner } from "../prisma";
import type {
	AppConfig,
	AppEnvVars,
	ComputedEnvVars,
	DevConfig,
	DevEnvironment,
	EnvValues,
	LinkConfig,
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
	/** Active profile name (`profiles.<name>`), applying its `env` and `secrets` overrides. */
	profile?: string;
	/** Explicit app selection (`buncargo dev <app>...`), overriding `profiles.default.apps` for `activeApps`. */
	onlyApps?: readonly string[];
} & SuffixedEnvironmentOptions;

/**
 * Create a dev environment from a configuration.
 *
 * @example
 * ```typescript
 * import { defineDevConfig } from 'buncargo'
 * import { createDevEnvironment } from 'buncargo/api'
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
	TLinks extends Record<string, LinkConfig> = Record<never, never>,
>(
	config: DevConfig<TServices, TApps, TEnv, TLinks>,
	options: EnvironmentOptions = {},
): DevEnvironment<TServices, TApps, TEnv, TLinks> {
	// The typed view, applied once: everything below reads the config with
	// its keys unknown, and builds the same object either way.
	return createEnvironment(
		config as DevConfig<AnyServices, AnyApps>,
		options,
	) as unknown as DevEnvironment<TServices, TApps, TEnv, TLinks>;
}

interface PreparedConfig {
	root: string;
	projectId: string | null;
	withProjectSecrets: DevConfig<AnyServices, AnyApps>;
	baseApplied: DevConfig<AnyServices, AnyApps>;
}

function prepareBaseConfig(
	config: DevConfig<AnyServices, AnyApps>,
	root: string,
): PreparedConfig {
	// Read `.infisical.json` at most once per checkout, and only when the config
	// or its integrations actually declare secrets.
	let projectId: string | null | undefined;
	const getProjectId = (): string | null => {
		if (projectId === undefined) {
			projectId = readInfisicalProjectId(root) ?? null;
		}
		return projectId;
	};
	const applyProjectSecrets = (target: DevConfig<AnyServices, AnyApps>) => {
		const hasSecrets =
			Boolean(target.secrets) ||
			Boolean(target.seed?.secrets) ||
			Boolean(target.migrations?.some((m) => Boolean(m.secrets))) ||
			Boolean(
				target.apps &&
				Object.values(target.apps).some((a) => Boolean(a.secrets)),
			) ||
			Boolean(
				target.profiles &&
				Object.values(target.profiles).some((p) => Boolean(p.secrets)),
			);
		return hasSecrets
			? applyInfisicalProjectConfig(target, root, getProjectId())
			: target;
	};
	const withProjectSecrets = applyProjectSecrets(config);
	const integrated = applyIntegrations(withProjectSecrets, { root });
	const baseApplied =
		integrated === withProjectSecrets
			? withProjectSecrets
			: applyProjectSecrets(integrated);
	assertValidConfig(baseApplied);
	return {
		root,
		projectId: projectId ?? null,
		withProjectSecrets,
		baseApplied,
	};
}

function createEnvironment(
	config: DevConfig<AnyServices, AnyApps>,
	options: EnvironmentOptions,
	preparedBase?: PreparedConfig,
	preResolved?: { profile?: string; resolved: ResolvedDevConfig },
): DevEnvironment<AnyServices, AnyApps> {
	const root = preparedBase?.root ?? options.root ?? findMonorepoRoot();
	const prepared = preparedBase ?? prepareBaseConfig(config, root);
	const profileName =
		options.profile ?? (config.profiles?.default ? "default" : undefined);

	let resolved: ResolvedDevConfig;
	if (preResolved && preResolved.profile === profileName) {
		resolved = preResolved.resolved;
	} else {
		const profileOverride = profileName
			? config.profiles?.[profileName]
			: undefined;
		let applied = prepared.baseApplied;
		if (profileOverride?.integrations !== undefined && profileName) {
			const integrated = applyProfileIntegrations(prepared.withProjectSecrets, {
				root,
				profile: profileName,
			});
			const projectId =
				prepared.projectId ?? readInfisicalProjectId(root) ?? null;
			applied = applyInfisicalProjectConfig(integrated, root, projectId);
			assertValidConfig(applied);
			const profileErrors: string[] = [];
			validateProfileAppRefs(
				profileName,
				profileOverride,
				applied.apps,
				profileErrors,
			);
			if (profileErrors.length > 0) {
				throw new Error(
					`Invalid dev config:\n${profileErrors.map((e) => `  - ${e}`).join("\n")}`,
				);
			}
		}

		resolved = resolveConfig(applied, {
			profile: options.profile,
			onlyApps: options.onlyApps,
		});
	}

	const ctx = createDevEnvContext(resolved, { ...options, root });
	const envVars = createEnvVarsApi(ctx);
	// The entry an app run publishes is built from the environment itself.
	const runClaim = createRunClaimApi(
		{
			projectName: ctx.projectName,
			projectSuffix: ctx.projectSuffix,
			profile: profileName,
			root: ctx.root,
			worktree: ctx.worktree,
			services: ctx.services,
			ports: ctx.ports,
			urls: ctx.urls,
			loopbackUrls: ctx.loopbackUrls,
			get selectedServiceKeys() {
				return ctx.selectedServiceKeys;
			},
			get hasSelectedServices() {
				return ctx.hasSelectedServices;
			},
			get runtime() {
				return ctx.runtime;
			},
			get runtimeBinary() {
				return ctx.runtimeBinary;
			},
			config: ctx.config,
			exportedEnv: (selection) => envVars.exportedEnv(selection),
		},
		() => ({
			sessionId: env.sessionId,
			containerRuntime: ctx.hasSelectedServices
				? env.containerRuntime
				: undefined,
			containerRuntimeBinary: ctx.hasSelectedServices
				? env.containerRuntimeBinary
				: undefined,
			projectPrefix: env.projectPrefix,
			projectName: env.projectName,
			projectSuffix: ctx.projectSuffix,
			profile: profileName,
			root: env.root,
			isWorktree: env.isWorktree,
			ports: env.ports,
			urls: env.urls,
			loopbackUrls: env.loopbackUrls,
			publicUrls: env.publicUrls,
			services: env.services,
			integrations: env.integrations,
			workspaceId: env.workspaceId,
			details: env.details,
			exportedEnv: (selection) => envVars.exportedEnv(selection),
			hosts: env.hosts,
			resolvePrimaryApp: env.resolvePrimaryApp,
		}),
	);
	const coordinator = new LifecycleCoordinator();
	const serviceWatch = createServiceWatch(ctx, runClaim.sessionId);
	const recordCapture = createCaptureRecorder(ctx, envVars);
	const renderFiles = () => renderGeneratedFiles(ctx, envVars);
	const appPipeline = createAppPipeline({
		root: ctx.root,
		ports: ctx.ports,
		projectName: ctx.projectName,
		unsetEnv: resolved.unsetEnv,
		egressGuard: resolved.egressGuard,
		linksConfig: resolved.links,
		allApps: ctx.apps,
		tasks: resolved.tasks,
		hasGeneratedFiles: (resolved.generatedFiles?.length ?? 0) > 0,
		hasActiveEgressProxy: () => ctx.egressProxyUrl !== undefined,
		egressProxy: () => ctx.egressProxy,
		setEgressProxy: ctx.setEgressProxy,
		runtime: () => ctx.runtime,
		appEnv: (name, production) => envVars.buildAppEnvVars(name, production),
		buildTaskEnv: envVars.buildTaskEnv,
		runHook: createServerHookRunner(ctx, envVars),
		onAppReady: async (name, signal) => {
			const appConfig = ctx.apps[name];
			if (!appConfig) return;
			for (const integration of resolved.integrations ?? []) {
				await integration.onAppReady?.({
					name,
					config: appConfig,
					port: ctx.ports[name],
					ports: ctx.ports,
					urls: ctx.urls,
					loopbackUrls: ctx.loopbackUrls,
					root: ctx.root,
					workspaceId: ctx.workspaceId,
					...(ctx.activeApps !== undefined
						? { activeApps: ctx.activeApps }
						: {}),
					signal,
				});
			}
		},
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
		renderGeneratedFiles: renderFiles,
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
		get links() {
			return ctx.links;
		},
		workspaceId: ctx.workspaceId,
		services: ctx.services,
		apps: ctx.apps,
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
			createEnvironment(
				config,
				{
					...options,
					suffix: newSuffix,
					data: suffixed?.data,
					ports: suffixed?.ports,
				},
				prepared,
				{ profile: profileName, resolved },
			),
	};

	registerInternals(env, {
		prepare: lifecycle.prepare,
		secretsSession: lifecycle.secretsSession,
		claimApps: appPipeline.claimApps,
		spawn: appPipeline.spawn,
		notify: serviceWatch.report,
		reportTo: (output) => {
			ctx.output = output;
		},
		renderGeneratedFiles: renderFiles,
		recordCapture,
		seed: resolved.seed
			? {
					command: resolved.seed.command,
					cwd: resolved.seed.cwd,
					beforeApps: resolved.seed.beforeApps,
					requiredServices: resolved.seed.requiredServices,
					afterApps: resolved.seed.afterApps,
				}
			: undefined,
		activeProfile: profileName,
		withProfile: (profile) =>
			createEnvironment(
				config,
				{ ...options, profile, onlyApps: undefined },
				prepared,
			),
		withOnlyApps: (onlyApps) =>
			createEnvironment(config, { ...options, onlyApps }, prepared),
		setupChecks: resolved.setupChecks,
		preflight: resolved.preflight,
		tasks: resolved.tasks,
		linksConfig: resolved.links,
		egressGuard: resolved.egressGuard,
		startTaskEgressGuard: envVars.startTaskEgressGuard,
		get activeApps() {
			return ctx.activeApps;
		},
		inspectLinks: ctx.inspectLinks,
		exportedEnv: (selection) => envVars.exportedEnv(selection),
		setNamedHostsActive: ctx.setNamedHostsActive,
		adoptLivePorts: ctx.adoptLivePorts,
		ensureComposeFile: ctx.ensureComposeFile,
		composeModel: ctx.composeModel,
		planPortOffset: ctx.planPortOffset,
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
