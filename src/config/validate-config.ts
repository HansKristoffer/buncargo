import { isAbsolute, normalize } from "node:path";
import { resolveSelectedApps } from "../planning";
import type { AppConfig, DevConfig, ServiceConfig } from "../types";

const BUILTIN_DOCKER_PRESETS = new Set(["postgres", "redis", "clickhouse"]);

function inferBuiltInPreset(serviceName: string): string | null {
	const normalized = serviceName.toLowerCase();
	return BUILTIN_DOCKER_PRESETS.has(normalized) ? normalized : null;
}

export function validateConfig<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(config: DevConfig<TServices, TApps>): string[] {
	const errors: string[] = [];
	const composeServiceNames = new Set<string>();

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
		const preset = inferBuiltInPreset(name);
		if (!dockerConfig && !preset) {
			errors.push(
				`Service "${name}" must define docker config (helper or raw) because it has no built-in preset.`,
			);
		}
		if (
			dockerConfig &&
			typeof dockerConfig === "object" &&
			"kind" in dockerConfig &&
			dockerConfig.kind === "preset"
		) {
			const presetName = dockerConfig.preset;
			if (
				typeof presetName !== "string" ||
				!BUILTIN_DOCKER_PRESETS.has(presetName)
			) {
				errors.push(
					`Service "${name}" has invalid docker preset "${presetName}".`,
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
		if (!app.port || typeof app.port !== "number") {
			errors.push(`App "${name}" must have a valid port number`);
		}
		if (!app.devCommand) {
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

export function assertValidConfig<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(config: DevConfig<TServices, TApps>): void {
	const errors = validateConfig(config);
	if (errors.length > 0) {
		throw new Error(`Invalid dev config:\n  - ${errors.join("\n  - ")}`);
	}
}
