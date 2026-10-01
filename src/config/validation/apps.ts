import { buildStartPlan } from "../../planning";
import { findStartAfterCycle } from "../../planning/start-planning";
import type { AnyDevConfig } from "../../types";
import type { ValidationContext } from "./context";

export function validateApps(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors, claimName, claimPort } = context;
	const captureOwners = new Map<string, string>();
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

		if (
			config.secrets !== false &&
			app.secrets &&
			!(app.secrets.projectId ?? config.secrets?.projectId)
		) {
			errors.push(
				`App "${name}" sets secrets without a projectId. Set apps.${name}.secrets.projectId, or secrets.projectId for every app.`,
			);
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

		for (const dependencyName of app.startAfter ?? []) {
			if (!config.apps?.[dependencyName]) {
				errors.push(
					`App "${name}" starts after unknown app "${dependencyName}"`,
				);
			} else if (dependencyName === name) {
				errors.push(`App "${name}" cannot start after itself`);
			}
		}

		if (app.prebuild !== undefined && !app.prebuild.trim()) {
			errors.push(`App "${name}" has an empty prebuild command`);
		}

		for (const [captureName, capture] of Object.entries(app.captures ?? {})) {
			if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(captureName)) {
				errors.push(
					`apps.${name}.captures.${captureName} must be an identifier (it is read as captured.${captureName})`,
				);
			}
			const owner = captureOwners.get(captureName);
			if (owner && owner !== name) {
				errors.push(
					`Capture "${captureName}" is declared by both ${owner} and ${name}`,
				);
			}
			captureOwners.set(captureName, name);
			if (capture.as === "publicUrl" && app.kind !== "worker" && app.expose) {
				errors.push(
					`apps.${name} captures its public URL and sets expose: a tunnel would overwrite it`,
				);
			}
		}

		for (const trigger of app.restartOn ?? []) {
			if (!/^(captured|publicUrls)\.[A-Za-z0-9_-]+$/.test(trigger)) {
				errors.push(
					`apps.${name}.restartOn "${trigger}" must be captured.<name> or publicUrls.<app>`,
				);
			}
		}
	}

	if (config.apps) {
		try {
			buildStartPlan(config.apps, config.services, undefined);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}

		const startCycle = findStartAfterCycle(config.apps);
		if (startCycle) {
			errors.push(`Circular startAfter dependency: ${startCycle}`);
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
}
