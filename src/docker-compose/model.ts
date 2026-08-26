import { inferDockerPreset } from "../core/service-presets";
import type {
	DockerComposeGenerationOptions,
	DockerComposeNode,
	DockerComposeServiceRaw,
	DockerComposeVolumeRaw,
	DockerPresetName,
	ServiceConfig,
} from "../types";
import { buildPresetDockerService } from "./services";
import { getDefaultPortBindings } from "./services/shared";

export type ComposeDocument = {
	name?: string;
	services: Record<string, DockerComposeServiceRaw>;
	volumes?: Record<string, DockerComposeVolumeRaw>;
};

export interface ComposeIdentity {
	projectName: string;
	root: string;
	worktree?: string | null;
}

function isObject(
	value: DockerComposeNode,
): value is Record<string, DockerComposeNode | undefined> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeNode(
	base: DockerComposeNode,
	override: DockerComposeNode,
): DockerComposeNode {
	if (Array.isArray(base) || Array.isArray(override)) {
		return override;
	}
	if (!isObject(base) || !isObject(override)) {
		return override;
	}

	const merged: Record<string, DockerComposeNode | undefined> = { ...base };
	for (const key of Object.keys(override)) {
		const baseValue = merged[key];
		const overrideValue = override[key];
		if (baseValue === undefined || overrideValue === undefined) {
			merged[key] = overrideValue;
		} else {
			merged[key] = deepMergeNode(baseValue, overrideValue);
		}
	}
	return merged;
}

function normalizeRawService(
	name: string,
	config: ServiceConfig,
	service: DockerComposeServiceRaw,
): DockerComposeServiceRaw {
	const normalized = { ...service };
	if (!normalized.ports || normalized.ports.length === 0) {
		normalized.ports = getDefaultPortBindings(name, config);
	}
	if (config.healthCheck === false) {
		delete normalized.healthcheck;
	}
	return normalized;
}

type NormalizedServiceConfig =
	| {
			kind: "preset";
			serviceName: string;
			preset: DockerPresetName;
			serviceOverride?: DockerComposeServiceRaw;
	  }
	| {
			kind: "raw";
			serviceName: string;
			service: DockerComposeServiceRaw;
	  };

function normalizeServiceConfig(
	name: string,
	config: ServiceConfig,
): NormalizedServiceConfig {
	const serviceName = config.serviceName ?? name;
	const rawDefinition = config.docker;

	if (rawDefinition?.kind === "preset") {
		return {
			kind: "preset",
			serviceName,
			preset: rawDefinition.preset,
			serviceOverride: rawDefinition.service,
		};
	}

	if (rawDefinition) {
		const inferredPreset = inferDockerPreset(name);
		if (inferredPreset) {
			return {
				kind: "preset",
				serviceName,
				preset: inferredPreset,
				serviceOverride: rawDefinition,
			};
		}
		return {
			kind: "raw",
			serviceName,
			service: normalizeRawService(name, config, rawDefinition),
		};
	}

	const preset = inferDockerPreset(name);
	if (!preset) {
		throw new Error(
			`Service "${name}" has no docker preset and no docker definition. Add service.docker using helper or raw mode.`,
		);
	}

	return {
		kind: "preset",
		serviceName,
		preset,
	};
}

function resolveServiceDefinition(
	name: string,
	config: ServiceConfig,
): {
	serviceName: string;
	service: DockerComposeServiceRaw;
	volume?: string;
} {
	const normalized = normalizeServiceConfig(name, config);
	if (normalized.kind === "raw") {
		return {
			serviceName: normalized.serviceName,
			service: normalized.service,
		};
	}

	const { service, volume } = buildPresetDockerService(normalized.preset, {
		serviceKey: name,
		config,
	});
	const mergedService = normalized.serviceOverride
		? (deepMergeNode(
				service as DockerComposeNode,
				normalized.serviceOverride as DockerComposeNode,
			) as DockerComposeServiceRaw)
		: service;
	return {
		serviceName: normalized.serviceName,
		service: mergedService,
		volume,
	};
}

export function buildComposeModel(
	services: Record<string, ServiceConfig>,
	docker?: DockerComposeGenerationOptions,
	identity?: ComposeIdentity,
): ComposeDocument {
	const composeServices: Record<string, DockerComposeServiceRaw> = {};
	const composeVolumes: Record<string, DockerComposeVolumeRaw> = {};

	for (const [name, serviceConfig] of Object.entries(services)) {
		const { serviceName, service, volume } = resolveServiceDefinition(
			name,
			serviceConfig,
		);
		if (identity) {
			service.labels = {
				...(typeof service.labels === "object" && service.labels !== null
					? (service.labels as Record<string, string>)
					: {}),
				"buncargo.project": identity.projectName,
				"buncargo.root": identity.root,
				"buncargo.worktree": identity.worktree ?? "",
				"buncargo.service": serviceName,
			};
		}
		composeServices[serviceName] = service;
		if (volume) {
			composeVolumes[volume] = {};
		}
	}

	for (const [volumeName, volume] of Object.entries(docker?.volumes ?? {})) {
		composeVolumes[volumeName] = volume;
	}

	const document: ComposeDocument = {
		name: "$" + "{COMPOSE_PROJECT_NAME}",
		services: composeServices,
	};
	if (Object.keys(composeVolumes).length > 0) {
		document.volumes = composeVolumes;
	}
	return document;
}
