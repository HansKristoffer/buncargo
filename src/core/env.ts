import type {
	AppConfig,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
	EnvVarsBuilder,
	ServiceConfig,
	ServiceEnvValueSource,
} from "../types";
import { resolveServiceEnvVarSources } from "./service-presets";

export type SharedEnvValues = Record<string, string | number>;

function getServiceEnvValue(
	serviceKey: string,
	source: ServiceEnvValueSource,
	ports: Record<string, number>,
	urls: Record<string, string>,
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
	publicUrls: ComputedPublicUrls<TServices, TApps>;
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

	for (const [name, url] of Object.entries(
		publicUrls as Record<string, string | undefined>,
	)) {
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
				ports as Record<string, number>,
				urls as Record<string, string>,
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
	ctx: {
		projectName: string;
		localIp: string;
		portOffset: number;
		publicUrls: ComputedPublicUrls<TServices, TApps>;
	},
): SharedEnvValues {
	if (!overlay) {
		return shared;
	}
	return {
		...shared,
		...overlay(ports, urls, ctx),
	};
}

export function stringifyEnvValues(
	envValues: Record<string, string | number>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(envValues).map(([key, value]) => [key, String(value)]),
	);
}
