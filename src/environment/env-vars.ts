import {
	buildSharedEnvValues,
	mergeSharedEnvWithOverlay,
	stringifyEnvValues,
} from "../core/env";
import { toPortMap } from "../core/ports";
import { type ExecResult, execAsync } from "../core/process";
import { isCI } from "../core/runtime-flags";
import type {
	AppConfig,
	AppEnvVars,
	ComputedEnvVars,
	ComputedPublicUrls,
	EnvValues,
	EnvVarsBuilder,
	ExecOptions,
	HookContext,
	ServiceConfig,
} from "../types";
import type { DevEnvContext } from "./context";

export interface DevEnvVarsApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> {
	buildEnvVars(production?: boolean): ComputedEnvVars<TServices, TApps, TEnv>;
	buildAppEnvVars<TName extends Extract<keyof TApps, string>>(
		appName: TName,
		production?: boolean,
	): AppEnvVars<TServices, TApps, TEnv, TName>;
	buildAppEnvVarsMap(
		targetApps: Record<string, AppConfig>,
		production?: boolean,
	): Record<string, Record<string, string>>;
	getHookContext(): HookContext<TServices, TApps>;
	exec(cmd: string, options?: ExecOptions): Promise<ExecResult>;
}

export function createEnvVarsApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
): DevEnvVarsApi<TServices, TApps, TEnv> {
	const { config, services, apps, ports, urls, publicUrls } = ctx;

	function overlayContext() {
		return {
			projectName: ctx.projectName,
			localIp: ctx.localIp,
			portOffset: ctx.portOffset,
			publicUrls: publicUrls as ComputedPublicUrls<TServices, TApps>,
		};
	}

	function buildEnvVars(
		production = false,
	): ComputedEnvVars<TServices, TApps, TEnv> {
		const shared = buildSharedEnvValues({
			projectName: ctx.projectName,
			production,
			services,
			ports,
			urls,
			publicUrls: publicUrls as ComputedPublicUrls<TServices, TApps>,
		});
		if (ctx.hosts?.active) {
			if (ctx.hosts.caPath) {
				shared.NODE_EXTRA_CA_CERTS = ctx.hosts.caPath;
			}
			shared.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = `.${ctx.hosts.tld}`;
		}
		// buildSharedEnvValues emits every computed name; TS cannot see that
		// through the dynamic record it returns.
		return stringifyEnvValues(
			mergeSharedEnvWithOverlay(
				shared,
				config.env,
				ports,
				urls,
				overlayContext(),
			),
		) as ComputedEnvVars<TServices, TApps, TEnv>;
	}

	function buildAppEnvVars<TName extends Extract<keyof TApps, string>>(
		appName: TName,
		production = false,
	): AppEnvVars<TServices, TApps, TEnv, TName> {
		const sharedEnv: Record<string, string> = buildEnvVars(production);
		const appConfig = apps[appName];
		const appEnvBuilder = appConfig?.envVars as
			| EnvVarsBuilder<TServices, TApps>
			| undefined;

		const appPort = toPortMap(ports)[appName];
		const processEnv: Record<string, string> = {
			...sharedEnv,
			...(appConfig?.staticEnv ? stringifyEnvValues(appConfig.staticEnv) : {}),
			HOST: "0.0.0.0",
		};
		if (appPort !== undefined) {
			processEnv.PORT = String(appPort);
		}
		// Last writer wins: an app's own `envVars` may override PORT/HOST.
		Object.assign(
			processEnv,
			appEnvBuilder
				? stringifyEnvValues(appEnvBuilder(ports, urls, overlayContext()))
				: {},
		);

		// The per-app keys come from `staticEnv`/`envVars`, which are opaque here
		// because the builder is widened to run against unknown apps.
		return processEnv as unknown as AppEnvVars<TServices, TApps, TEnv, TName>;
	}

	function buildAppEnvVarsMap(
		targetApps: Record<string, AppConfig>,
		production = false,
	): Record<string, Record<string, string>> {
		return Object.fromEntries(
			Object.keys(targetApps).map((appName) => [
				appName,
				buildAppEnvVars(appName as Extract<keyof TApps, string>, production),
			]),
		);
	}

	function exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		return execAsync(cmd, ctx.root, buildEnvVars(), options);
	}

	// Created once, then reused so hooks observe a stable identity.
	let hookContext: HookContext<TServices, TApps> | null = null;

	function getHookContext(): HookContext<TServices, TApps> {
		if (!hookContext) {
			hookContext = {
				projectName: ctx.projectName,
				ports,
				urls,
				publicUrls: publicUrls as ComputedPublicUrls<TServices, TApps>,
				root: ctx.root,
				isCI: isCI(),
				portOffset: ctx.portOffset,
				localIp: ctx.localIp,
				exec: async (cmd, opts) => exec(cmd, opts),
			};
		}
		return hookContext;
	}

	return {
		buildEnvVars,
		buildAppEnvVars,
		buildAppEnvVarsMap,
		getHookContext,
		exec,
	};
}
