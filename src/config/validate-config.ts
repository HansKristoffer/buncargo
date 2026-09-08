import { isAbsolute, normalize } from "node:path";
import {
	CONTAINER_RUNTIME_SELECTIONS,
	isContainerRuntimeSelection,
} from "../container-runtime/names";
import { sanitizeTld } from "../core/hosts/plan";
import {
	DOCKER_PRESET_NAMES,
	inferDockerPreset,
	isDockerPresetName,
	resolveServiceEnvVarSources,
} from "../core/service-presets";
import { buildStartPlan } from "../planning";
import { resolveServiceDependencies } from "../planning/start-planning";
import type { AnyDevConfig, DevConfig, DevConfigLike } from "../types";
import { validateConfigShape } from "./validate-shape";

/**
 * Collect every problem with a dev config, in the order they were found.
 *
 * Dynamic configs cross a shape boundary before semantic checks. Typed
 * configs use the same boundary without losing their own callback signatures.
 */
export function validateConfig(value: unknown): string[] {
	const errors = validateConfigShape(value);
	if (errors.length > 0) {
		return errors;
	}

	const config = value as AnyDevConfig;
	const portOwners = new Map<number, string>();
	const namespaceOwners = new Map<string, string>();
	const claimName = (name: string, path: string) => {
		const previous = namespaceOwners.get(name);
		if (previous) {
			errors.push(
				`${path} conflicts with ${previous} in the computed ports/URLs namespace`,
			);
		} else {
			namespaceOwners.set(name, path);
		}
	};
	const claimPort = (port: number | undefined, path: string) => {
		if (!Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65535) {
			errors.push(`${path} must be an integer between 1 and 65535`);
			return;
		}

		const previous = portOwners.get(port as number);
		if (previous) {
			errors.push(`${path} duplicates port ${port} used by ${previous}`);
		} else {
			portOwners.set(port as number, path);
		}
	};
	const composeServiceNames = new Set<string>();
	const derivedEnvOwners = new Map<string, string>();

	if ("envVars" in (config as object)) {
		errors.push(
			"Top-level envVars has been removed. Use the top-level env overlay for shared values, or apps.<name>.envVars for app-only values.",
		);
	}

	if (!config.projectPrefix) {
		errors.push("projectPrefix is required");
	} else if (!/^[a-z][a-z0-9-]*$/.test(config.projectPrefix)) {
		errors.push(
			"projectPrefix must start with a letter and contain only lowercase letters, numbers, and hyphens",
		);
	}

	if (!config.services) {
		errors.push(
			"services must be an object (use {} for app-only configurations)",
		);
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

	if (config.docker?.writeStrategy) {
		const writeStrategy = config.docker.writeStrategy;
		if (writeStrategy !== "always" && writeStrategy !== "if-missing") {
			errors.push(
				`docker.writeStrategy "${String(writeStrategy)}" is invalid. Use "always" or "if-missing".`,
			);
		}
	}

	if (
		config.docker?.runtime &&
		!isContainerRuntimeSelection(config.docker.runtime)
	) {
		errors.push(
			`docker.runtime "${String(config.docker.runtime)}" is invalid. Use ${CONTAINER_RUNTIME_SELECTIONS.map((value) => `"${value}"`).join(", ")}.`,
		);
	}

	if (config.docker?.binary && !isAbsolute(config.docker.binary)) {
		errors.push("docker.binary must be an absolute path to a runtime binary.");
	}

	// One override, two backends: under "auto" there is no way to tell which
	// one the path belongs to until after the probe that would have to run it.
	if (config.docker?.binary && config.docker.runtime === "auto") {
		errors.push(
			'docker.binary cannot be combined with docker.runtime: "auto" - it names one runtime\'s executable, so set docker.runtime to "docker" or "apple".',
		);
	}

	if (config.docker?.generatedFile) {
		const generatedFile = config.docker.generatedFile;
		if (isAbsolute(generatedFile)) {
			errors.push(
				"docker.generatedFile must be a relative path inside the repo.",
			);
		}

		const normalized = normalize(generatedFile).replace(/\\/g, "/");
		if (normalized === ".." || normalized.startsWith("../")) {
			errors.push(
				"docker.generatedFile cannot point outside the repository root.",
			);
		}
	}

	for (const [name, app] of Object.entries(config.apps ?? {})) {
		claimName(name, `apps.${name}`);
		if (app.kind === "worker") {
			for (const field of ["port", "expose", "healthEndpoint", "expo"] as const)
				if (app[field] !== undefined) {
					errors.push(`Worker "${name}" cannot set ${field}`);
				}
			if (typeof app.devCommand !== "string") {
				errors.push(`Worker "${name}" requires a devCommand`);
			}
		} else {
			if (app.kind !== undefined && app.kind !== "server") {
				errors.push(`App "${name}" has an invalid kind`);
			}
			claimPort(app.port, `apps.${name}.port`);
		}

		if ("env" in (app as object)) {
			errors.push(
				`App "${name}" uses "env", which was renamed to "staticEnv" to avoid colliding with the top-level env overlay. Use apps.${name}.staticEnv for constants, or apps.${name}.envVars for computed values.`,
			);
		}

		if (app.kind !== "worker" && (!app.port || typeof app.port !== "number")) {
			errors.push(`App "${name}" must have a valid port number`);
		}

		if (app.devCommand !== false && !app.devCommand) {
			errors.push(`App "${name}" must have a devCommand`);
		}

		for (const serviceName of app.requiredServices ?? []) {
			if (!config.services?.[serviceName]) {
				errors.push(`App "${name}" requires unknown service "${serviceName}"`);
			}
		}

		for (const dependencyName of app.requiredApps ?? []) {
			if (!config.apps?.[dependencyName]) {
				errors.push(`App "${name}" requires unknown app "${dependencyName}"`);
			}
		}
	}

	if (config.apps) {
		try {
			buildStartPlan(config.apps, config.services, undefined);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}

		const interactiveApps = Object.entries(config.apps)
			.filter(([, app]) => app.interactive)
			.map(([name]) => name);
		if (interactiveApps.length > 1) {
			errors.push(
				`Only one app may set interactive: true. Found: ${interactiveApps.join(", ")}`,
			);
		}
	}

	const preparationEntries = [
		...(config.migrations ?? []).map((entry, index) => ({
			path: `migrations.${index}`,
			requiredServices: entry.requiredServices,
		})),
		{ path: "seed", requiredServices: config.seed?.requiredServices },
	];

	for (const { path, requiredServices } of preparationEntries) {
		if (requiredServices === undefined) {
			continue;
		}

		if (
			!Array.isArray(requiredServices) ||
			requiredServices.some(
				(name) => typeof name !== "string" || !config.services[name],
			)
		) {
			errors.push(`${path}.requiredServices must name configured services`);
		}
	}

	// Prisma has an implicit database prerequisite; apply the same phase rule
	// as explicit migration/seed entries without changing its legacy validation.
	const prismaPrerequisites = config.prisma
		? [config.prisma.service ?? "postgres"]
		: undefined;

	for (const { path, requiredServices } of [
		...preparationEntries,
		{ path: "prisma", requiredServices: prismaPrerequisites },
	]) {
		if (!Array.isArray(requiredServices)) {
			continue;
		}

		for (const name of requiredServices) {
			if (typeof name === "string" && config.services[name]?.afterPreparation) {
				errors.push(
					`${path} requires service "${name}", which starts after preparation`,
				);
			}
		}
	}

	for (const migration of config.migrations ?? []) {
		if (!migration.name) {
			errors.push("Migration must have a name");
		}

		if (!migration.command) {
			errors.push(`Migration "${migration.name}" must have a command`);
		}
	}

	if (config.seed && !config.seed.command) {
		errors.push("Seed must have a command");
	}

	if (config.prisma?.service && !config.services?.[config.prisma.service]) {
		errors.push(
			`prisma.service "${config.prisma.service}" must match a configured service key`,
		);
	}

	for (const optionKey of [
		"primaryApp",
		"expoApiApp",
		"frontendApp",
	] as const) {
		const appName = config.options?.[optionKey];
		if (appName && !config.apps?.[appName]) {
			errors.push(
				`options.${optionKey} "${appName}" must match a configured app key`,
			);
		}
	}

	const hosts = config.options?.hosts;
	if (hosts && hosts !== true) {
		if (hosts.tld) {
			try {
				sanitizeTld(hosts.tld);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}

		if (hosts.primaryApp && !config.apps?.[hosts.primaryApp]) {
			errors.push(
				`options.hosts.primaryApp "${hosts.primaryApp}" must match a configured app key`,
			);
		}

		if (Array.isArray(hosts.services)) {
			for (const name of hosts.services) {
				if (!config.services[name]) {
					errors.push(
						`options.hosts.services includes unknown service "${name}"`,
					);
				}
			}
		}
	}

	if (config.prisma?.cwd) {
		if (isAbsolute(config.prisma.cwd)) {
			errors.push("prisma.cwd must be a relative path inside the repo.");
		}

		const normalized = normalize(config.prisma.cwd).replace(/\\/g, "/");
		if (normalized === ".." || normalized.startsWith("../")) {
			errors.push("prisma.cwd cannot point outside the repository root.");
		}
	}

	return errors;
}

/**
 * Throw unless `config` is a valid dev config.
 *
 * Accepts `unknown` so a config imported at runtime can be validated before
 * use; for an already-typed config the assertion is a no-op, since every
 * {@link DevConfig} satisfies {@link DevConfigLike}.
 */
export function assertValidConfig(
	config: unknown,
): asserts config is DevConfigLike {
	const errors = validateConfig(config);
	if (errors.length > 0) {
		throw new Error(`Invalid dev config:\n  - ${errors.join("\n  - ")}`);
	}
}
