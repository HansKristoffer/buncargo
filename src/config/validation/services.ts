import { getErrorMessage } from "hanzio";
import {
	DOCKER_PRESET_NAMES,
	isDockerPresetName,
} from "../../core/service-presets";
import { resolveServiceDependencies } from "../../planning";
import type { AnyDevConfig, ResolvedService, ServiceConfig } from "../../types";
import { resolveService } from "../resolve";
import type { ValidationContext } from "./context";

export function validateServices(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors, claimName, claimPort } = context;
	const composeServiceNames = new Set<string>();
	const derivedEnvOwners = new Map<string, string>();
	const stacks = new Set(
		(config.integrations ?? []).flatMap((integration) =>
			Object.keys(integration.stacks ?? {}),
		),
	);
	const resolved = new Map<string, ResolvedService>();
	for (const [name, service] of Object.entries(config.services ?? {})) {
		// An unknown preset is reported below, and resolves to nothing.
		const docker = service.docker;
		if (docker?.kind === "preset" && !isDockerPresetName(docker.preset))
			continue;
		try {
			resolved.set(name, resolveService(name, service));
		} catch (error) {
			errors.push(getErrorMessage(error));
		}
	}
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

		const composeServiceName = service.serviceName ?? name;
		if (composeServiceNames.has(composeServiceName)) {
			errors.push(
				`Duplicate compose service name "${composeServiceName}". Use unique serviceName values.`,
			);
		}
		composeServiceNames.add(composeServiceName);

		const dockerConfig = service.docker;
		if (service.external) {
			validateExternalService(name, service, stacks, errors);
		} else if (!dockerConfig && !isDockerPresetName(name)) {
			errors.push(
				`Service "${name}" needs docker: a preset (docker: service.postgres(), or a key named after one: ${DOCKER_PRESET_NAMES.join(", ")}) or a raw Compose definition.`,
			);
		}

		// Credentials go into a preset's container and URL; a custom container
		// reads neither, and its URL comes from `urlTemplate`.
		const custom =
			!service.external &&
			dockerConfig !== undefined &&
			dockerConfig.kind !== "preset";
		for (const field of ["database", "user", "password"] as const)
			if (custom && service[field] !== undefined)
				errors.push(
					`Service "${name}" sets ${field}, which only a preset reads. Use docker: service.<preset>({ ${field} }), or put it in the image's environment and urlTemplate.`,
				);

		if (
			dockerConfig?.kind === "preset" &&
			!isDockerPresetName(dockerConfig.preset)
		) {
			errors.push(
				`Service "${name}" has invalid docker preset "${String(dockerConfig.preset)}". Valid presets: ${DOCKER_PRESET_NAMES.join(", ")}.`,
			);
		}

		const serviceEnvSources = resolved.get(name)?.env ?? {};
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
		resolveServiceDependencies(
			Object.fromEntries(resolved),
			Object.keys(config.services),
		);
	} catch (error) {
		errors.push(getErrorMessage(error));
	}
}

function validateExternalService(
	name: string,
	service: ServiceConfig,
	stacks: ReadonlySet<string>,
	errors: string[],
): void {
	const stack = service.external?.stack;
	if (!stack || !stacks.has(stack)) {
		errors.push(
			`Service "${name}" is provided by stack "${String(stack)}", which no integration defines`,
		);
	}
	if (service.docker) {
		errors.push(
			`Service "${name}" is provided by stack "${stack}" and cannot also define docker`,
		);
	}
	if (service.kind === "job" || service.afterPreparation) {
		errors.push(
			`Service "${name}" is provided by stack "${stack}" and cannot be a job or afterPreparation`,
		);
	}
}
