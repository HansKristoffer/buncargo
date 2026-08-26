import type {
	AppConfig,
	ComputedPorts,
	ComputedUrls,
	EnvValues,
	EnvVarsBuilder,
	EnvVarsContext,
	ServiceConfig,
	ServiceEnvValueSource,
} from "../types";
import { type PortMap, toPortMap, toUrlMap, type UrlMap } from "./ports";
import { resolveServiceEnvVarSources } from "./service-presets";

export type SharedEnvValues = EnvValues;

function getServiceEnvValue(
	serviceKey: string,
	source: ServiceEnvValueSource,
	ports: PortMap,
	urls: UrlMap,
): string | number | undefined {
	switch (source) {
		case "url":
			return urls[serviceKey];
		case "port":
			return ports[serviceKey];
		case "secondaryPort":
			return ports[`${serviceKey}Secondary`];
		default:
			return undefined;
	}
}

export function buildSharedEnvValues<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(input: {
	projectName: string;
	production?: boolean;
	services: TServices;
	ports: ComputedPorts<TServices, TApps>;
	urls: ComputedUrls<TServices, TApps>;
	/** Only iterated, so the widest read-only shape a caller can hold is enough. */
	publicUrls: Readonly<Record<string, string | undefined>>;
}): SharedEnvValues {
	const {
		projectName,
		production = false,
		services,
		ports,
		urls,
		publicUrls,
	} = input;

	const sharedEnv: SharedEnvValues = {
		COMPOSE_PROJECT_NAME: projectName,
		NODE_ENV: production ? "production" : "development",
	};

	for (const [name, port] of Object.entries(ports)) {
		sharedEnv[`${name.toUpperCase()}_PORT`] = port;
	}

	for (const [name, url] of Object.entries(urls)) {
		sharedEnv[`${name.toUpperCase()}_URL`] = url;
	}

	for (const [name, url] of Object.entries(publicUrls)) {
		if (url !== undefined) {
			sharedEnv[`${name.toUpperCase()}_PUBLIC_URL`] = url;
		}
	}

	for (const [serviceKey, service] of Object.entries(services)) {
		const envSources = resolveServiceEnvVarSources(serviceKey, service);
		for (const [envName, source] of Object.entries(envSources)) {
			const value = getServiceEnvValue(
				serviceKey,
				source,
				toPortMap(ports),
				toUrlMap(urls),
			);
			if (value !== undefined) {
				sharedEnv[envName] = value;
			}
		}
		if (service.staticEnv) {
			Object.assign(sharedEnv, service.staticEnv);
		}
	}

	return sharedEnv;
}

export function mergeSharedEnvWithOverlay<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	shared: SharedEnvValues,
	overlay: EnvVarsBuilder<TServices, TApps> | undefined,
	ports: ComputedPorts<TServices, TApps>,
	urls: ComputedUrls<TServices, TApps>,
	ctx: EnvVarsContext<TServices, TApps>,
): SharedEnvValues {
	if (!overlay) {
		return shared;
	}
	return {
		...shared,
		...overlay(ports, urls, ctx),
	};
}

/**
 * Stringify env values for a child process, dropping `undefined` entries.
 *
 * Configs may pass `process.env.X` or an optional public URL straight through;
 * an absent value must stay absent instead of becoming `"undefined"`.
 */
export function stringifyEnvValues(
	envValues: EnvValues,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(envValues)) {
		if (value !== undefined) {
			result[key] = String(value);
		}
	}
	return result;
}
