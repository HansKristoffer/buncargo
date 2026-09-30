import {
	DOCKER_PRESET_NAMES,
	inferDockerPreset,
	isDockerPresetName,
	resolveServiceEnvVarSources,
} from "../../core/service-presets";
import { resolveServiceDependencies } from "../../planning/start-planning";
import type { AnyDevConfig } from "../../types";
import type { ValidationContext } from "./context";

export function validateServices(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors, claimName, claimPort } = context;
	const composeServiceNames = new Set<string>();
	const derivedEnvOwners = new Map<string, string>();
	for (const [name, service] of Object.entries(config.services ?? {})) {
		claimName(name, `services.${name}`);
		if (service.port !== undefined) {
			claimPort(service.port, `services.${name}.port`);
		}

		if (service.kind === "job") {
			if (service.rerun !== "always") {
				errors.push(`Job "${name}" must explicitly set rerun: "always"`);
			}

			for (const field of [
				"port",
				"secondaryPort",
				"healthCheck",
				"expose",
				"urlTemplate",
			] as const)
				if (service[field] !== undefined) {
					errors.push(`Job "${name}" cannot set ${field}`);
				}
		} else if (service.kind !== undefined && service.kind !== "service") {
			errors.push(`Service "${name}" has invalid kind`);
		}

		if (
			service.port === undefined &&
			(service.expose ||
				service.urlTemplate ||
				service.healthCheck ||
				service.secondaryPort !== undefined)
		) {
			errors.push(
				`Portless service "${name}" uses process state readiness and cannot expose a host endpoint`,
			);
		}

		const raw =
			service.docker?.kind === "preset"
				? service.docker.service
				: service.docker;
		if (service.kind === "job" && raw?.restart && raw.restart !== "no") {
			errors.push(`Job "${name}" cannot have a restart policy`);
		}

		if (service.port === undefined && raw?.ports?.length) {
			errors.push(`Portless service "${name}" cannot publish Compose ports`);
		}

		if (service.secondaryPort !== undefined) {
			claimName(`${name}Secondary`, `services.${name}.secondaryPort`);
			claimPort(service.secondaryPort, `services.${name}.secondaryPort`);
		}

		if (
			service.secondaryPort !== undefined &&
			(service.secondaryPort < 1 || service.secondaryPort > 65535)
		) {
			errors.push(
				`Service "${name}" secondaryPort must be between 1 and 65535`,
			);
		}

		const composeServiceName = service.serviceName ?? name;
		if (composeServiceNames.has(composeServiceName)) {
			errors.push(
				`Duplicate compose service name "${composeServiceName}". Use unique serviceName values.`,
			);
		}
		composeServiceNames.add(composeServiceName);

		const dockerConfig = service.docker;
		if (!dockerConfig && !inferDockerPreset(name)) {
			errors.push(
				`Service "${name}" must define docker config (helper or raw) because it has no built-in preset.`,
			);
		}

		if (
			dockerConfig?.kind === "preset" &&
			!isDockerPresetName(dockerConfig.preset)
		) {
			errors.push(
				`Service "${name}" has invalid docker preset "${String(dockerConfig.preset)}". Valid presets: ${DOCKER_PRESET_NAMES.join(", ")}.`,
			);
		}

		const serviceEnvSources = resolveServiceEnvVarSources(name, service);
		for (const [envName, source] of Object.entries(serviceEnvSources)) {
			if (service.port === undefined && source !== "secondaryPort") {
				errors.push(
					`Portless service "${name}" cannot derive env "${envName}" from ${source}`,
				);
			}

			const existingOwner = derivedEnvOwners.get(envName);
			if (existingOwner && existingOwner !== name) {
				errors.push(
					`Derived env var "${envName}" is declared by multiple services (${existingOwner}, ${name}). Rename one of them or use explicit service.env mappings.`,
				);
			} else {
				derivedEnvOwners.set(envName, name);
			}

			if (source === "secondaryPort" && service.secondaryPort === undefined) {
				errors.push(
					`Service "${name}" declares env "${envName}" from secondaryPort but no secondaryPort is configured.`,
				);
			}
		}
	}

	try {
		resolveServiceDependencies(config.services, Object.keys(config.services));
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
}
