import { anySignal, recordFromKeys } from "hanzio";
import { secretCaptureEnvKeys } from "../core/captured-values";
import {
	envOverlayContext,
	exportableSharedEnv,
	type SharedEnvExtras,
	sharedEnv,
} from "../core/checkout-view";
import {
	allowedHostsOf,
	buildNoProxyList,
	EGRESS_GUARD_ENV_KEYS,
	egressGuardEnv,
	formatBlockedEgress,
	guardsApp,
	guardsTask,
	startEgressGuardProxy,
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
import { formatWarn } from "../core/style";
import type {
	EnvVarsBuilder,
	ExecOptions,
	HookContext,
	ResolvedApp,
	ResolvedLink,
	SecretsScopeInput,
	TaskConfig,
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
	/**
	 * One run of `task`'s env: its app's (or the shared) env over its secrets,
	 * behind the run's egress proxy when the task is guarded and one is active.
	 */
	buildTaskEnv(
		task: TaskConfig,
		production: boolean,
		signal?: AbortSignal,
	): Promise<Record<string, string>>;
	/**
	 * An egress proxy of its own for one guarded `task` outside a run
	 * (`buncargo run`), its `allowHostsOf` hosts read from the task's env. The
	 * returned `env` points the task at it. `undefined` when the task is not
	 * guarded.
	 */
	startTaskEgressGuard(
		task: TaskConfig,
		signal?: AbortSignal,
	): Promise<
		{ env: Record<string, string>; close(): Promise<void> } | undefined
	>;
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

	/** What points a process at the egress proxy at `proxyUrl`, this checkout's hosts exempt. */
	function egressEnvFor(proxyUrl: string): Record<string, string> {
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
		return egressGuardEnv(proxyUrl, buildNoProxyList(extraNoProxy));
	}

	function buildAppEnvVarsWithShared(
		appName: string,
		production: boolean,
		liveLinks: Readonly<Record<string, ResolvedLink | undefined>>,
		shared: Record<string, string>,
	): Record<string, string> {
		const envExtras = extras(production, liveLinks);
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
						...(ctx.activeApps !== undefined
							? { activeApps: ctx.activeApps }
							: {}),
					}),
				);
			}
		}

		const egressEnv =
			ctx.egressProxyUrl &&
			config.egressGuard?.enabled &&
			guardsApp(config.egressGuard, appName)
				? egressEnvFor(ctx.egressProxyUrl)
				: {};

		const processEnv: Record<string, string> = {
			...shared,
			ASTRO_DEV_BACKGROUND: "1",
			ASTRO_PREVIEW_BACKGROUND: "1",
			...integrationEnv,
			...egressEnv,
			...(appConfig?.staticEnv ? stringifyEnvValues(appConfig.staticEnv) : {}),
			// A worker listens on nothing.
			...(appConfig && appConfig.port === undefined
				? {}
				: { HOST: appConfig?.host ?? "0.0.0.0" }),
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

	function buildAppEnvVars(
		appName: string,
		production = false,
		liveLinks: Readonly<Record<string, ResolvedLink | undefined>> = ctx.links,
	): Record<string, string> {
		return buildAppEnvVarsWithShared(
			appName,
			production,
			liveLinks,
			buildEnvVars(production, liveLinks),
		);
	}

	function buildEnvFingerprint(appName: string, production = false): string {
		const liveLinks = ctx.links;
		const linkedNames = Object.values(liveLinks).flatMap((link) =>
			link ? [link.root, link.projectName] : [],
		);
		const egressProxyPort =
			ctx.egressProxy?.port ??
			(ctx.egressProxyUrl
				? Number(new URL(ctx.egressProxyUrl).port)
				: undefined);
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
		const shared = buildEnvVars(production, liveLinks);
		return recordFromKeys(Object.keys(targetApps), (appName) =>
			buildAppEnvVarsWithShared(appName, production, liveLinks, shared),
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

	async function buildTaskEnv(
		task: TaskConfig,
		production: boolean,
		signal?: AbortSignal,
	): Promise<Record<string, string>> {
		const computed = task.app
			? buildAppEnvVars(task.app, production)
			: buildEnvVars(production);

		// A guarded app's env carries the proxy; the task's own setting decides.
		const guarded = guardsTask(config.egressGuard, task);
		const borrowsGuard =
			task.app !== undefined &&
			config.egressGuard !== undefined &&
			guardsApp(config.egressGuard, task.app);
		// Beneath what the task's env sets itself, as for an app; an opt-out
		// removes only the values the guard put there.
		const guardEnv = ctx.egressProxyUrl
			? egressEnvFor(ctx.egressProxyUrl)
			: undefined;
		if (guarded && guardEnv) {
			for (const [key, value] of Object.entries(guardEnv)) {
				computed[key] ??= value;
			}
		} else if (!guarded && borrowsGuard && guardEnv) {
			for (const key of EGRESS_GUARD_ENV_KEYS) {
				if (computed[key] === guardEnv[key]) delete computed[key];
			}
		}

		const secrets = await resolveSecrets(undefined, {
			app: task.app,
			signal,
			computed,
		});
		const env = { ...secrets, ...computed };
		if (guarded) learnTaskEgressHosts(task, env, ctx.egressProxy);
		return env;
	}

	const reportedTaskKeys = new Set<string>();

	/** `allowHostsOf` for one task run: its hosts join `proxy`'s allowlist. */
	function learnTaskEgressHosts(
		task: TaskConfig,
		env: Readonly<Record<string, string>>,
		proxy: { allowHosts(hosts: readonly string[]): void } | undefined,
	): void {
		const keys = config.egressGuard?.allowHostsOf ?? [];
		if (!proxy || keys.length === 0) return;

		const { hosts, unresolved } = allowedHostsOf(keys, {
			...process.env,
			...env,
		});
		proxy.allowHosts(hosts);
		const label = task.description ?? task.command;
		// Once per task and key: a watched task runs again on every change.
		const unreported = unresolved.filter(
			(key) => !reportedTaskKeys.has(`${label}|${key}`),
		);
		for (const key of unreported) reportedTaskKeys.add(`${label}|${key}`);
		if (unreported.length > 0) {
			ctx.output.log(
				formatWarn(
					`egressGuard.allowHostsOf: the task "${label}" has no URL in ${unreported.join(", ")}, so no host is let through for it.`,
				),
			);
		}
	}

	async function startTaskEgressGuard(task: TaskConfig, signal?: AbortSignal) {
		const guard = config.egressGuard;
		if (!guard || !guardsTask(guard, task)) return undefined;

		const proxy = await startEgressGuardProxy({
			allow: guard.allow,
			mode: guard.mode,
			onBlocked: (event) =>
				console.warn(formatWarn(formatBlockedEgress(event))),
		});
		try {
			if (guard.allowHostsOf.length > 0) {
				const env = await buildTaskEnv(task, false, signal);
				learnTaskEgressHosts(task, env, proxy);
			}
		} catch (error) {
			await proxy.close();
			throw error;
		}
		return { env: egressEnvFor(proxy.url), close: () => proxy.close() };
	}

	// Created once, then reused so hooks observe a stable identity.
	let hookContext: HookContext<AnyServices, AnyApps> | null = null;

	const scopedContexts = new WeakMap<
		AbortSignal,
		HookContext<AnyServices, AnyApps>
	>();

	function createHookContext(
		signal: AbortSignal | undefined,
		selection: StartSelection | undefined,
	): HookContext<AnyServices, AnyApps> {
		const execForHook: HookContext<AnyServices, AnyApps>["exec"] = signal
			? (cmd, options) =>
					exec(cmd, {
						...options,
						timeoutMs: options?.timeoutMs ?? 600000,
						signal: anySignal(signal, options?.signal),
					})
			: async (cmd, opts) => exec(cmd, opts);
		const hookActiveApps = (() => {
			if (config.activeApps === undefined) return undefined;
			if (!selection || selection.appNames.length === 0) return ctx.activeApps;
			const base = ctx.activeApps ?? config.activeApps;
			if (!selection.appNames.some((app) => !base.has(app))) return base;
			const next = new Set(base);
			for (const app of selection.appNames) next.add(app);
			return next;
		})();
		return {
			selectedApps: selection ? [...selection.appNames] : Object.keys(apps),
			selectedServices: selection
				? [...selection.requiredServiceKeys]
				: Object.keys(services),
			projectName: ctx.projectName,
			ports,
			urls,
			loopbackUrls,
			publicUrls,
			root: ctx.root,
			isCI: isCI(),
			get portOffset() {
				return ctx.portOffset;
			},
			localIp: ctx.localIp,
			captured: ctx.captured,
			get links() {
				return ctx.links;
			},
			...(hookActiveApps !== undefined ? { activeApps: hookActiveApps } : {}),
			...(config.secrets !== undefined ? { secrets: config.secrets } : {}),
			...(signal ? { signal } : {}),
			exec: execForHook,
		};
	}

	function getHookContext(
		signal?: AbortSignal,
		selection: StartSelection | undefined = ctx.selection,
	): HookContext<AnyServices, AnyApps> {
		if (selection) {
			return createHookContext(signal, selection);
		}
		return scopedHookContext(signal);
	}

	function scopedHookContext(
		signal?: AbortSignal,
	): HookContext<AnyServices, AnyApps> {
		if (!signal) {
			hookContext ??= createHookContext(undefined, undefined);
			return hookContext;
		}

		let scoped = scopedContexts.get(signal);
		if (!scoped) {
			scoped = createHookContext(signal, undefined);
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
		buildTaskEnv,
		startTaskEgressGuard,
	};
}
