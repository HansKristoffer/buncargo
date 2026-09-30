import { toPortMap } from "../core/ports";
import {
	configuredPrimaryApp,
	type PrimaryAppInput,
} from "../core/primary-app";
import { logExpoApiUrl, logFrontendPort } from "../core/utils";
import type { AppConfig, EnvValues, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";

/** Compatibility helpers retained while projects move to integrations and primaryApp. */
export function createLegacyLinks<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
>(ctx: DevEnvContext<TServices, TApps, TEnv>) {
	function getExpoApiUrl(): string {
		const expoIntegration = ctx.config.integrations?.find(
			(integration) => integration.name === "expo",
		) as { apiApp?: string } | undefined;
		const appName =
			ctx.config.options?.expoApiApp ?? expoIntegration?.apiApp ?? "api";
		const apiPort = toPortMap(ctx.ports)[appName];
		const url = `http://${ctx.localIp}:${apiPort}`;
		logExpoApiUrl(url);
		return url;
	}

	function getFrontendPort(): number | undefined {
		// `frontendApp` first: it is the narrower knob, and a project that set
		// both means the frontend is not the primary app.
		const configured =
			ctx.config.options?.frontendApp ??
			configuredPrimaryApp(ctx.config.options as PrimaryAppInput["options"]);
		const portMap = toPortMap(ctx.ports);
		const port =
			(configured ? portMap[configured] : undefined) ??
			portMap.platform ??
			portMap.web;
		logFrontendPort(port);
		return port;
	}

	return { getExpoApiUrl, getFrontendPort };
}
