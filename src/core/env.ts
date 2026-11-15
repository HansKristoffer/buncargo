import { typedSwitch } from "hanzio";
import type {
	AppConfig,
	ComputedPorts,
	ComputedUrls,
	EnvValues,
	EnvVarsBuilder,
	EnvVarsContext,
	ResolvedService,
	ResolvedServices,
	ServiceConfig,
	ServiceEnvValueSource,
} from "../types";
import {
	envName,
	type PortMap,
	toPortMap,
	toUrlMap,
	type UrlMap,
} from "./ports";

function getServiceEnvValue(
	serviceKey: string,
	source: ServiceEnvValueSource,
	ports: PortMap,
	urls: UrlMap,
): string | number | undefined {
	// A config that skipped validation can name another source: it yields nothing.
	return typedSwitch(
		source,
		{
			url: () => urls[serviceKey],
			port: () => ports[serviceKey],
			secondaryPort: () => ports[`${serviceKey}Secondary`],
		},
		() => undefined,
	);
}

export function buildSharedEnvValues<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(input: {
	projectName: string;
	production?: boolean;
	services: ResolvedServices<TServices>;
	ports: ComputedPorts<TServices, TApps>;
	urls: ComputedUrls<TServices, TApps>;
	/** Only iterated, so the widest read-only shape a caller can hold is enough. */
	loopbackUrls?: Readonly<Record<string, string>>;
	/** Only iterated, so the widest read-only shape a caller can hold is enough. */
	publicUrls: Readonly<Record<string, string | undefined>>;
}): EnvValues {
	const {
		projectName,
		production = false,
		services,
		ports,
		urls,
		loopbackUrls,
		publicUrls,
	} = input;

	const portMap = toPortMap(ports);
	const urlMap = toUrlMap(urls);

	const sharedEnv: EnvValues = {
		COMPOSE_PROJECT_NAME: projectName,
		NODE_ENV: production ? "production" : "development",
	};

	for (const [name, port] of Object.entries(portMap)) {
		sharedEnv[`${envName(name)}_PORT`] = port;
	}

	for (const [name, url] of Object.entries(urlMap)) {
		sharedEnv[`${envName(name)}_URL`] = url;
	}

	// Emitted alongside `<NAME>_URL` so a process handed a named HTTPS URL it
	// cannot verify still has the loopback address to fall back to.
	for (const [name, url] of Object.entries(loopbackUrls ?? {})) {
		sharedEnv[`${envName(name)}_LOOPBACK_URL`] = url;
	}

	for (const [name, url] of Object.entries(publicUrls)) {
		if (url !== undefined) {
			sharedEnv[`${envName(name)}_PUBLIC_URL`] = url;
		}
	}

	for (const [serviceKey, service] of Object.entries<ResolvedService>(
		services,
	)) {
		for (const [varName, source] of Object.entries(service.env)) {
			const value = getServiceEnvValue(serviceKey, source, portMap, urlMap);
			if (value !== undefined) {
				sharedEnv[varName] = value;
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
	shared: EnvValues,
	overlay: EnvVarsBuilder<TServices, TApps> | undefined,
	ports: ComputedPorts<TServices, TApps>,
	urls: ComputedUrls<TServices, TApps>,
	ctx: EnvVarsContext<TServices, TApps>,
): EnvValues {
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
