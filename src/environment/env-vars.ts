import { anySignal, recordFromKeys } from "hanzio";
import {
	envOverlayContext,
	type SharedEnvExtras,
	sharedEnv,
} from "../core/checkout-view";
import { stringifyEnvValues } from "../core/env";
import { portableEnvFingerprint } from "../core/env-fingerprint";
import { applyEnvOverrides, warnShadowedSecrets } from "../core/env-overrides";
import { unallocatedPortsMessage } from "../core/port-exhaustion";
import { type ExecResult, execAsync } from "../core/process";
import { isCI } from "../core/runtime-flags";
import {
	describeSecretsError,
	loadScopeSecrets,
	resolveScope,
	stopsTheRun,
	warnSecretsOnce,
} from "../core/secrets/index";
import type {
	EnvVarsBuilder,
	ExecOptions,
	HookContext,
	ResolvedApp,
	SecretsScopeConfig,
} from "../types";
import type {
	AnyApps,
	AnyServices,
	DevEnvContext,
	StartSelection,
} from "./context";

export interface DevEnvVarsApi {
	buildEnvVars(production?: boolean): Record<string, string>;
	buildAppEnvVars(
		appName: string,
		production?: boolean,
	): Record<string, string>;
	buildAppEnvVarsMap(
		targetApps: Record<string, ResolvedApp>,
		production?: boolean,
	): Record<string, Record<string, string>>;
	buildEnvFingerprint(appName: string, production?: boolean): string;
	/** Without a selection, hooks see the prepared one (every name before preparation). */
	getHookContext(
		signal?: AbortSignal,
		selection?: StartSelection,
	): HookContext<AnyServices, AnyApps>;
	/** `production` builds the env a production start gives its processes. */
	exec(
		cmd: string | readonly string[],
		options?: ExecOptions,
		production?: boolean,
	): Promise<ExecResult>;
	/** `exec` for an integration stack's `down`, which reaches no port: allowed without a port block. */
	execTeardown(
		cmd: string | readonly string[],
		options?: ExecOptions,
	): Promise<ExecResult>;
	/**
	 * The secrets a command gets: `explicit`, else the app's scope, else the
	 * config-level one, minus every key the computed env already sets. A
	 * failed fetch warns once per scope and yields none, like an app's.
	 */
	resolveSecrets(
		explicit: SecretsScopeConfig | false | undefined,
		options?: {
			app?: string;
			signal?: AbortSignal;
			computed?: Record<string, string>;
		},
	): Promise<Record<string, string>>;
}

export function createEnvVarsApi(ctx: DevEnvContext): DevEnvVarsApi {
	const { config, services, apps, ports, urls, loopbackUrls, publicUrls } = ctx;

	function extras(production = false): SharedEnvExtras {
		return {
			production,
			publicUrls: ctx.publicUrls,
			captured: ctx.captured,
			hosts: ctx.hosts,
		};
	}

	function buildEnvVars(production = false): Record<string, string> {
		return stringifyEnvValues(sharedEnv(ctx, extras(production)));
	}

	function buildAppEnvVars(
		appName: string,
		production = false,
	): Record<string, string> {
		const sharedEnv: Record<string, string> = buildEnvVars(production);
		const appConfig = apps[appName];
		// A resolved app's builder takes `never`: it was written for its own config's keys.
		const appEnvBuilder = appConfig?.envVars as
			EnvVarsBuilder<AnyServices, AnyApps> | undefined;

		const appPort = ports[appName];
		const processEnv: Record<string, string> = {
			...sharedEnv,
			ASTRO_DEV_BACKGROUND: "1",
			ASTRO_PREVIEW_BACKGROUND: "1",
			...(appConfig?.staticEnv ? stringifyEnvValues(appConfig.staticEnv) : {}),
			// A worker listens on nothing.
			...(appConfig && appConfig.port === undefined ? {} : { HOST: "0.0.0.0" }),
			// So a framework plugin can configure itself without the consumer
			// repeating which app it is. Nothing else tells the child process.
			BUNCARGO_APP_NAME: appName,
		};

		if (appPort !== undefined) {
			processEnv.PORT = String(appPort);
		}

		// Integrations sit beneath the app's own `envVars`, which may override them.
		if (appConfig) {
			for (const integration of config.integrations ?? []) {
				Object.assign(
					processEnv,
					integration.appEnv?.({
						name: appName,
						config: appConfig,
						port: appPort,
						root: ctx.root,
						workspaceId: ctx.workspaceId,
					}),
				);
			}
		}

		// The loopback daemon's; a Tailscale-served app has only its URL.
		const namedHost =
			ctx.hosts?.active && ctx.hosts.mode === "loopback"
				? ctx.hosts.plan.find(
						(host) => host.kind === "app" && host.name === appName,
					)
				: undefined;
		if (namedHost) {
			processEnv.BUNCARGO_APP_HOSTNAME = namedHost.hostname;
		}
		// Last writer wins: an app's own `envVars` may override PORT/HOST.
		Object.assign(
			processEnv,
			appEnvBuilder
				? stringifyEnvValues(
						appEnvBuilder(
							ports,
							urls,
							envOverlayContext(ctx, extras(production)),
						),
					)
				: {},
		);
		// Above the app's own `envVars` too: an override is the checkout's last word.
		applyEnvOverrides(processEnv, ctx.envOverrides, ctx.inputEnv.declared);
		return processEnv;
	}

	function buildEnvFingerprint(appName: string, production = false): string {
		return portableEnvFingerprint(buildAppEnvVars(appName, production), {
			ports: Object.values(ports),
			names: [ctx.root, ctx.projectName, ctx.workspaceId],
		});
	}

	function buildAppEnvVarsMap(
		targetApps: Record<string, ResolvedApp>,
		production = false,
	): Record<string, Record<string, string>> {
		return recordFromKeys(Object.keys(targetApps), (appName) =>
			buildAppEnvVars(appName, production),
		);
	}

	async function resolveSecrets(
		explicit: SecretsScopeConfig | false | undefined,
		options: {
			app?: string;
			signal?: AbortSignal;
			computed?: Record<string, string>;
		} = {},
	): Promise<Record<string, string>> {
		if (explicit === false) return {};
		const scope =
			explicit ??
			(options.app === undefined ? config.secrets : apps[options.app]?.secrets);
		if (!scope) return {};
		const resolved = resolveScope(scope, config.secrets);
		if (!resolved) return {};
		try {
			const values = await loadScopeSecrets(resolved, {
				signal: options.signal,
				onWait: (ms) => ctx.onSecretsWait?.(ms),
			});
			const computed = options.computed ?? {};
			warnShadowedSecrets(ctx.root, ctx.envOverrides, Object.keys(values));
			return Object.fromEntries(
				Object.entries(values).filter(([key]) => computed[key] === undefined),
			);
		} catch (error) {
			options.signal?.throwIfAborted();
			// The command's own loader would wait on the same login.
			if (stopsTheRun(error)) throw error;
			warnSecretsOnce(
				resolved,
				`Could not load Infisical secrets: ${describeSecretsError(error)}`,
			);
			return {};
		}
	}

	async function exec(
		cmd: string | readonly string[],
		options?: ExecOptions,
		production = false,
	): Promise<ExecResult> {
		// Its ports would be another checkout's: a command would reach that
		// checkout's database.
		if (ctx.portOffsetProvenance === "unallocated")
			throw new Error(unallocatedPortsMessage(ctx.root));
		return execTeardown(cmd, options, production);
	}

	/**
	 * {@link exec} without the unallocated-ports refusal, for an integration
	 * stack's `down`: it stops this checkout's stack by its project name and
	 * reaches no port, and refusing left the stack running.
	 */
	async function execTeardown(
		cmd: string | readonly string[],
		options?: ExecOptions,
		production = false,
	): Promise<ExecResult> {
		if (options?.app !== undefined && !apps[options.app]) {
			throw new Error(`Unknown app "${options.app}"`);
		}

		const computed: Record<string, string> =
			options?.app === undefined
				? buildEnvVars(production)
				: buildAppEnvVars(options.app, production);
		// Beneath the computed env and anything passed explicitly, like an app's.
		const secrets = await resolveSecrets(options?.secrets, {
			app: options?.app,
			signal: options?.signal,
			computed,
		});
		return execAsync(cmd, ctx.root, computed, {
			...options,
			env: { ...secrets, ...options?.env },
			cwd:
				options?.cwd ??
				(options?.app === undefined ? undefined : apps[options.app]?.cwd),
			unsetEnv: ctx.config.unsetEnv,
		});
	}

	// Created once, then reused so hooks observe a stable identity.
	let hookContext: HookContext<AnyServices, AnyApps> | null = null;

	const scopedContexts = new WeakMap<
		AbortSignal,
		HookContext<AnyServices, AnyApps>
	>();

	function getHookContext(
		signal?: AbortSignal,
		selection: StartSelection | undefined = ctx.selection,
	): HookContext<AnyServices, AnyApps> {
		if (selection) {
			return {
				...scopedHookContext(signal),
				selectedApps: [...selection.appNames],
				selectedServices: [...selection.requiredServiceKeys],
			};
		}
		return scopedHookContext(signal);
	}

	function scopedHookContext(
		signal?: AbortSignal,
	): HookContext<AnyServices, AnyApps> {
		if (!hookContext) {
			hookContext = {
				selectedApps: Object.keys(apps),
				selectedServices: Object.keys(services),
				projectName: ctx.projectName,
				ports,
				urls,
				loopbackUrls,
				publicUrls,
				root: ctx.root,
				isCI: isCI(),
				portOffset: ctx.portOffset,
				localIp: ctx.localIp,
				captured: ctx.captured,
				exec: async (cmd, opts) => exec(cmd, opts),
			};
		}

		if (!signal) {
			return hookContext;
		}

		let scoped = scopedContexts.get(signal);
		if (!scoped) {
			scoped = {
				...hookContext,
				signal,
				exec: (cmd, options) =>
					exec(cmd, {
						...options,
						timeoutMs: options?.timeoutMs ?? 600000,
						signal: anySignal(signal, options?.signal),
					}),
			};
			scopedContexts.set(signal, scoped);
		}

		return scoped;
	}

	return {
		buildEnvVars,
		buildAppEnvVars,
		buildAppEnvVarsMap,
		buildEnvFingerprint,
		getHookContext,
		exec,
		execTeardown,
		resolveSecrets,
	};
}
