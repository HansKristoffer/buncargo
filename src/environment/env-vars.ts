import { anySignal, recordFromKeys } from "hanzio";
import { secretCaptureEnvKeys } from "../core/captured-values";
import {
	envOverlayContext,
	exportableSharedEnv,
	type SharedEnvExtras,
	sharedEnv,
} from "../core/checkout-view";
import {
	buildNoProxyList,
	egressGuardEnv,
	guardsApp,
} from "../core/egress-guard";
import { stringifyEnvValues } from "../core/env";
import { portableEnvFingerprint } from "../core/env-fingerprint";
import { applyEnvOverrides, warnShadowedSecrets } from "../core/env-overrides";
import { linkedPortsOf, pickExportedEnv } from "../core/links";
import { unallocatedPortsMessage } from "../core/port-exhaustion";
import { type ExecResult, execAsync } from "../core/process";
import { isCI } from "../core/runtime-flags";
import {
	describeSecretsError,
	loadScopeSecrets,
	resolveScopes,
	stopsTheRun,
	warnSecretsOnce,
} from "../core/secrets/index";
import type {
	EnvVarsBuilder,
	ExecOptions,
	HookContext,
	ResolvedApp,
	ResolvedLink,
	SecretsScopeInput,
} from "../types";
import type {
	AnyApps,
	AnyServices,
	DevEnvContext,
	StartSelection,
} from "./context";

/** {@link ExecOptions}, plus where a verbose command's lines go. */
type CommandOptions = ExecOptions & { onOutputLine?: (line: string) => void };

/** Active selection passed to `exportedEnv` so integrations only publish live endpoints. */
interface ExportedEnvSelection {
	readonly apps?: readonly string[];
	readonly services?: readonly string[];
	readonly production?: boolean;
}

export interface DevEnvVarsApi {
	buildEnvVars(
		production?: boolean,
		liveLinks?: Readonly<Record<string, ResolvedLink | undefined>>,
	): Record<string, string>;
	buildAppEnvVars(
		appName: string,
		production?: boolean,
		liveLinks?: Readonly<Record<string, ResolvedLink | undefined>>,
	): Record<string, string>;
	buildAppEnvVarsMap(
		targetApps: Record<string, ResolvedApp>,
		production?: boolean,
	): Record<string, Record<string, string>>;
	buildEnvFingerprint(appName: string, production?: boolean): string;
	/** Non-secret shared env vars (`exportEnv`, integrations) for publishing to `runs.json`. */
	exportedEnv(selection?: ExportedEnvSelection): Record<string, string>;
	/** Without a selection, hooks see the prepared one (every name before preparation). */
	getHookContext(
		signal?: AbortSignal,
		selection?: StartSelection,
	): HookContext<AnyServices, AnyApps>;
	/**
	 * `production` builds the env a production start gives its processes.
	 * With `verbose`, `onOutputLine` takes each line instead of the terminal.
	 */
	exec(
		cmd: string | readonly string[],
		options?: CommandOptions,
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
		explicit: SecretsScopeInput | false | undefined,
		options?: {
			app?: string;
			signal?: AbortSignal;
			computed?: Record<string, string>;
		},
	): Promise<Record<string, string>>;
}

export function createEnvVarsApi(ctx: DevEnvContext): DevEnvVarsApi {
	const { config, services, apps, ports, urls, loopbackUrls, publicUrls } = ctx;

	function extras(
		production = false,
		liveLinks: Readonly<Record<string, ResolvedLink | undefined>> = ctx.links,
	): SharedEnvExtras {
		return {
			production,
			publicUrls: ctx.publicUrls,
			captured: ctx.captured,
			hosts: ctx.hosts,
			links: liveLinks,
		};
	}

	function buildEnvVars(
		production = false,
		liveLinks: Readonly<Record<string, ResolvedLink | undefined>> = ctx.links,
	): Record<string, string> {
		return stringifyEnvValues(sharedEnv(ctx, extras(production, liveLinks)));
	}

	function exportedEnv(
		selection?: ExportedEnvSelection,
	): Record<string, string> {
		const integrations = config.integrations ?? [];
		const hasIntegrationExports = integrations.some(
			(integration) => integration.exportEnv !== undefined,
		);
		const keys = config.exportEnv;
		const hasConfigExports = keys !== undefined && keys.length > 0;
		if (!hasIntegrationExports && !hasConfigExports) return {};

		const exported: Record<string, string> = {};
		if (hasIntegrationExports) {
			const effectiveSelection: StartSelection | undefined =
				selection?.apps !== undefined || selection?.services !== undefined
					? {
							appNames: selection.apps ?? ctx.selection?.appNames ?? [],
							requiredServiceKeys:
								selection.services ?? ctx.selection?.requiredServiceKeys ?? [],
						}
					: ctx.selection;
			const hookCtx = getHookContext(undefined, effectiveSelection);
			for (const integration of integrations) {
				const values = integration.exportEnv?.(hookCtx);
				if (values) Object.assign(exported, values);
			}
		}

		if (hasConfigExports) {
			const safeVars = stringifyEnvValues(
				exportableSharedEnv(ctx, extras(selection?.production ?? false)),
			);
			Object.assign(exported, pickExportedEnv(safeVars, keys));
		}

		for (const secretKey of secretCaptureEnvKeys(apps)) {
			delete exported[secretKey];
		}
		return exported;
	}

	function buildAppEnvVars(
		appName: string,
		production = false,
		liveLinks: Readonly<Record<string, ResolvedLink | undefined>> = ctx.links,
	): Record<string, string> {
		const envExtras = extras(production, liveLinks);
		const shared = buildEnvVars(production, liveLinks);
		const appConfig = apps[appName];

		// A resolved app's builder takes `never`: it was written for its own config's keys.
		const appEnvBuilder = appConfig?.envVars as
			EnvVarsBuilder<AnyServices, AnyApps> | undefined;
		const appPort = ports[appName];
		// Integrations sit beneath everything the app's config sets itself,
		// `staticEnv` and `envVars` alike: the user's values win.
		const integrationEnv: Record<string, string> = {};
		if (appConfig) {
			for (const integration of config.integrations ?? []) {
				Object.assign(
					integrationEnv,
					integration.appEnv?.({
						name: appName,
						config: appConfig,
						port: appPort,
						root: ctx.root,
						workspaceId: ctx.workspaceId,
						...(config.activeApps !== undefined
							? { activeApps: config.activeApps }
							: {}),
					}),
				);
			}
		}

		const egressEnv: Record<string, string> = {};
		if (
			ctx.egressProxyUrl &&
			config.egressGuard?.enabled &&
			guardsApp(config.egressGuard, appName)
		) {
			const extraNoProxy: string[] = [];
			if (ctx.localIp) {
				extraNoProxy.push(ctx.localIp);
			}
			if (ctx.hosts?.tld && ctx.hosts.tld !== "localhost") {
				extraNoProxy.push(`.${ctx.hosts.tld}`);
			}
			for (const url of Object.values(ctx.hosts?.tailscaleUrls ?? {})) {
				try {
					extraNoProxy.push(new URL(url).hostname);
				} catch {
					// Ignore non-URL strings.
				}
			}
			Object.assign(
				egressEnv,
				egressGuardEnv(ctx.egressProxyUrl, buildNoProxyList(extraNoProxy)),
			);
		}

		const processEnv: Record<string, string> = {
			...shared,
			ASTRO_DEV_BACKGROUND: "1",
			ASTRO_PREVIEW_BACKGROUND: "1",
			...integrationEnv,
			...egressEnv,
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
						appEnvBuilder(ports, urls, envOverlayContext(ctx, envExtras)),
					)
				: {},
		);

		// Above the app's own `envVars` too: an override is the checkout's last word.
		applyEnvOverrides(processEnv, ctx.envOverrides, ctx.inputEnv.declared);
		return processEnv;
	}

	function buildEnvFingerprint(appName: string, production = false): string {
		const liveLinks = ctx.links;
		const linkedNames = Object.values(liveLinks).flatMap((link) =>
			link ? [link.root, link.projectName] : [],
		);
		const egressProxyPort = ctx.egressProxyUrl
			? Number(new URL(ctx.egressProxyUrl).port)
			: undefined;
		return portableEnvFingerprint(
			buildAppEnvVars(appName, production, liveLinks),
			{
				ports: [
					...Object.values(ports),
					...linkedPortsOf(liveLinks),
					...(egressProxyPort ? [egressProxyPort] : []),
				],
				names: [ctx.root, ctx.projectName, ctx.workspaceId, ...linkedNames],
			},
		);
	}

	function buildAppEnvVarsMap(
		targetApps: Record<string, ResolvedApp>,
		production = false,
	): Record<string, Record<string, string>> {
		const liveLinks = ctx.links;
		return recordFromKeys(Object.keys(targetApps), (appName) =>
			buildAppEnvVars(appName, production, liveLinks),
		);
	}

	async function resolveSecrets(
		explicit: SecretsScopeInput | false | undefined,
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

		const resolved = resolveScopes(scope, config.secrets);
		if (resolved.length === 0) return {};

		const layers = await Promise.all(
			resolved.map(async (entry) => {
				try {
					return await loadScopeSecrets(entry, {
						signal: options.signal,
						onWait: (ms) => ctx.onSecretsWait?.(ms),
					});
				} catch (error) {
					options.signal?.throwIfAborted();
					// The command's own loader would wait on the same login.
					if (stopsTheRun(error)) throw error;
					warnSecretsOnce(
						entry,
						`Could not load Infisical secrets: ${describeSecretsError(error)}`,
					);
					return {};
				}
			}),
		);

		const values: Record<string, string> = {};
		for (const layer of layers) Object.assign(values, layer);

		const computed = options.computed ?? {};
		warnShadowedSecrets(ctx.root, ctx.envOverrides, Object.keys(values));

		return Object.fromEntries(
			Object.entries(values).filter(([key]) => computed[key] === undefined),
		);
	}

	async function exec(
		cmd: string | readonly string[],
		options?: CommandOptions,
		production = false,
	): Promise<ExecResult> {
		// Its ports would be another checkout's: a command would reach that
		// checkout's database.
		if (ctx.portOffsetProvenance === "unallocated") {
			throw new Error(unallocatedPortsMessage(ctx.root));
		}

		return execTeardown(cmd, options, production);
	}

	/**
	 * {@link exec} without the unallocated-ports refusal, for an integration
	 * stack's `down`: it stops this checkout's stack by its project name and
	 * reaches no port, and refusing left the stack running.
	 */
	async function execTeardown(
		cmd: string | readonly string[],
		options?: CommandOptions,
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
				get links() {
					return ctx.links;
				},
				...(config.activeApps !== undefined
					? { activeApps: config.activeApps }
					: {}),
				...(config.secrets !== undefined ? { secrets: config.secrets } : {}),
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
				get links() {
					return ctx.links;
				},
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
		exportedEnv,
		getHookContext,
		exec,
		execTeardown,
		resolveSecrets,
	};
}
