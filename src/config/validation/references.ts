import { isAbsolute, normalize } from "node:path";
import { sanitizeTld } from "../../core/hosts/plan";
import type { AnyDevConfig } from "../../types";
import type { ValidationContext } from "./context";

export function validateReferences(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors } = context;
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

	const checkRelativePath = (path: string, value: string | undefined) => {
		if (!value) return;
		if (isAbsolute(value)) {
			errors.push(`${path} must be a relative path inside the repo.`);
		}

		const normalized = normalize(value).replace(/\\/g, "/");
		if (normalized === ".." || normalized.startsWith("../")) {
			errors.push(`${path} cannot point outside the repository root.`);
		}
	};

	checkRelativePath("prisma.cwd", config.prisma?.cwd);

	const generatedPaths = new Set<string>();
	for (const [index, file] of (config.generatedFiles ?? []).entries()) {
		checkRelativePath(`generatedFiles.${index}.path`, file.path);
		const normalized = normalize(file.path);
		if (generatedPaths.has(normalized)) {
			errors.push(`generatedFiles lists ${file.path} twice`);
		}
		generatedPaths.add(normalized);
	}

	for (const [name, task] of Object.entries(config.tasks ?? {})) {
		if (task.app && !config.apps?.[task.app]) {
			errors.push(
				`tasks.${name}.app "${task.app}" must match a configured app key`,
			);
		}

		for (const serviceName of task.requiredServices ?? []) {
			if (!config.services[serviceName]) {
				errors.push(`tasks.${name} requires unknown service "${serviceName}"`);
			}
		}

		checkRelativePath(`tasks.${name}.cwd`, task.cwd);
	}

	for (const [name, profile] of Object.entries(config.profiles ?? {})) {
		for (const appName of profile.apps) {
			if (!config.apps?.[appName]) {
				errors.push(`profiles.${name} includes unknown app "${appName}"`);
			}
		}
	}
}
