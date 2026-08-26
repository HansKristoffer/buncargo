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
import { resolveSelectedApps } from "../planning";
import type { AnyDevConfig, DevConfig, DevConfigLike } from "../types";

/**
 * Collect every problem with a dev config, in the order they were found.
 *
 * Takes the widened {@link AnyDevConfig} view rather than a generic
 * `DevConfig`: every concrete config is assignable to it, and validation only
 * ever reads fields, so it never needs the config's own callback signatures.
 */
export function validateConfig(config: AnyDevConfig): string[] {
	const errors: string[] = [];
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

	if (!config.services || Object.keys(config.services).length === 0) {
		errors.push("At least one service is required");
	}

	for (const [name, service] of Object.entries(config.services ?? {})) {
		if (!service.port || typeof service.port !== "number") {
			errors.push(`Service "${name}" must have a valid port number`);
		}
		if (service.port < 1 || service.port > 65535) {
			errors.push(`Service "${name}" port must be between 1 and 65535`);
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
		if ("env" in (app as object)) {
			errors.push(
				`App "${name}" uses "env", which was renamed to "staticEnv" to avoid colliding with the top-level env overlay. Use apps.${name}.staticEnv for constants, or apps.${name}.envVars for computed values.`,
			);
		}
		if (!app.port || typeof app.port !== "number") {
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
			resolveSelectedApps(config.apps, undefined);
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

	for (const optionKey of ["expoApiApp", "frontendApp"] as const) {
		const appName = config.options?.[optionKey];
		if (appName && config.apps && !config.apps[appName]) {
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
		if (hosts.primaryApp && config.apps && !config.apps[hosts.primaryApp]) {
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
	// validateConfig reads every field defensively, so the widened view is safe
	// here even when the value turns out not to be a config at all.
	const errors = validateConfig(config as AnyDevConfig);
	if (errors.length > 0) {
		throw new Error(`Invalid dev config:\n  - ${errors.join("\n  - ")}`);
	}
}
