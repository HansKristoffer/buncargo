import { normalize } from "node:path";
import { getErrorMessage } from "hanzio";
import { sanitizeTld } from "../../core/hosts/plan";
import { resolvePrismaConfig } from "../../prisma/config";
import type { AnyDevConfig } from "../../types";
import type { ValidationContext } from "./context";

export function validateReferences(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors, checkRelativePath } = context;
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
	// as explicit migration/seed entries.
	const prismaPrerequisites = config.prisma
		? [resolvePrismaConfig(config.prisma).service]
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

	if (config.seed?.afterApps !== undefined) {
		const { afterApps } = config.seed;
		if (
			!Array.isArray(afterApps) ||
			afterApps.some((name) => typeof name !== "string" || !config.apps?.[name])
		) {
			errors.push("seed.afterApps must name configured apps");
		} else {
			const apps = config.apps ?? {};
			for (const name of afterApps) {
				if (apps[name]?.essential === false) {
					errors.push(
						`seed.afterApps cannot include "${name}" because apps.${name}.essential is false`,
					);
				}
			}

			if (config.seed.beforeApps !== false) {
				const needsPublic = new Set<string>(
					Object.entries(apps)
						.filter(([, app]) => app.needsPublicUrls)
						.map(([name]) => name),
				);
				let expanded = needsPublic.size > 0;
				while (expanded) {
					expanded = false;
					for (const [name, app] of Object.entries(apps)) {
						if (needsPublic.has(name)) continue;
						if (app.startAfter?.some((dep) => needsPublic.has(dep))) {
							needsPublic.add(name);
							expanded = true;
						}
					}
				}
				for (const name of afterApps) {
					if (needsPublic.has(name)) {
						errors.push(
							`seed.afterApps cannot include "${name}" because it waits for public URLs (needsPublicUrls); set seed.beforeApps: false or remove needsPublicUrls`,
						);
					}
				}
			}
		}
	}

	if (config.prisma?.service && !config.services?.[config.prisma.service]) {
		errors.push(
			`prisma.service "${config.prisma.service}" must match a configured service key`,
		);
	}

	const primaryApp = config.options?.primaryApp;
	if (primaryApp && !config.apps?.[primaryApp]) {
		errors.push(
			`options.primaryApp "${primaryApp}" must match a configured app key`,
		);
	}

	const hosts = config.options?.hosts;
	if (hosts && hosts !== true) {
		if (hosts.tld) {
			try {
				sanitizeTld(hosts.tld);
			} catch (error) {
				errors.push(getErrorMessage(error));
			}
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

	checkRelativePath("prisma.cwd", config.prisma?.cwd);
	checkRelativePath("prisma.migrations", config.prisma?.migrations);

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

		const reactive =
			(task.onAppReady !== undefined && task.onAppReady.length > 0) ||
			task.watch !== undefined;

		for (const appName of task.onAppReady ?? []) {
			const targetApp = config.apps?.[appName];
			if (!targetApp) {
				errors.push(
					`tasks.${name}.onAppReady includes unknown app "${appName}"`,
				);
			} else if (targetApp.devCommand === false) {
				errors.push(
					`tasks.${name}.onAppReady references port-only app "${appName}" (devCommand: false), which buncargo does not spawn`,
				);
			}
		}

		if (reactive) {
			if (config.apps?.[name]) {
				errors.push(
					`Reactive task "${name}" shares a name with apps.${name}; rename the task so its TUI pane and log file stay distinct.`,
				);
			} else if (config.services[name]) {
				errors.push(
					`Reactive task "${name}" shares a name with services.${name}; rename the task so its TUI pane and log file stay distinct.`,
				);
			} else if (name === "buncargo" || name === "seed" || name === "egress") {
				errors.push(
					`Reactive task "${name}" uses a reserved log name; rename the task.`,
				);
			}
		}

		checkRelativePath(`tasks.${name}.cwd`, task.cwd);
	}

	for (const [name, profile] of Object.entries(config.profiles ?? {})) {
		// Profiles that override `integrations` change which integration-added apps
		// exist; their app lists are validated after those integrations are applied.
		if (profile.integrations === undefined) {
			for (const appName of profile.apps ?? []) {
				if (!config.apps?.[appName]) {
					errors.push(`profiles.${name} includes unknown app "${appName}"`);
				}
			}
			if (
				profile.egressGuard &&
				typeof profile.egressGuard === "object" &&
				profile.egressGuard.apps
			) {
				for (const appName of profile.egressGuard.apps) {
					if (!config.apps?.[appName]) {
						errors.push(
							`profiles.${name}.egressGuard.apps includes unknown app "${appName}"`,
						);
					}
				}
			}
		}
		for (const linkName of Object.keys(profile.links ?? {})) {
			if (!config.links?.[linkName]) {
				errors.push(
					`profiles.${name}.links includes unknown link "${linkName}"`,
				);
			}
		}
	}

	if (
		config.egressGuard &&
		typeof config.egressGuard === "object" &&
		config.egressGuard.apps
	) {
		for (const appName of config.egressGuard.apps) {
			if (!config.apps?.[appName]) {
				errors.push(`egressGuard.apps includes unknown app "${appName}"`);
			}
		}
	}

	if (config.exportEnv && config.exportEnv.length > 0) {
		const secretCaptureEnvs = new Map<string, string>();
		for (const [appName, app] of Object.entries(config.apps ?? {})) {
			for (const [captureName, capture] of Object.entries(app.captures ?? {})) {
				if (capture.secret && capture.env) {
					secretCaptureEnvs.set(capture.env, `${appName}.${captureName}`);
				}
			}
		}
		for (const key of config.exportEnv) {
			const secretSource = secretCaptureEnvs.get(key);
			if (secretSource) {
				errors.push(
					`exportEnv cannot include "${key}" because capture "${secretSource}" is marked secret`,
				);
			}
		}
	}

	// A step whose apps are never selected never runs, so a misspelt name would
	// skip it without a word.
	const configuredApps = Object.keys(config.apps ?? {}).join(", ") || "none";
	for (const step of config.preflight ?? []) {
		for (const appName of step.apps ?? []) {
			if (!config.apps?.[appName]) {
				errors.push(
					`preflight "${step.name}" includes unknown app "${appName}" (configured apps: ${configuredApps})`,
				);
			}
		}
	}
}
