import { buildStartPlan } from "../../planning";
import { findStartAfterCycle } from "../../planning/start-planning";
import type { AnyDevConfig } from "../../types";
import type { ValidationContext } from "./context";

/**
 * Keys the TUI keeps for itself, besides arrows, Enter and Esc (`run-tui.ts`).
 * A declared action may not use one.
 */
export const BUILT_IN_KEYS = ["o", "e", "r", "l", "q", "j", "k"] as const;

export function validateApps(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors, claimName, claimPort } = context;
	const captureOwners = new Map<string, string>();
	for (const [name, app] of Object.entries(config.apps ?? {})) {
		claimName(name, `apps.${name}`);
		if (app.kind === "worker") {
			for (const field of ["port", "expose", "healthEndpoint"] as const)
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

		const keys = new Set<string>();
		const actions = Array.isArray(app.actions) ? app.actions : [];
		for (const [index, action] of actions.entries()) {
			const at = `apps.${name}.actions[${index}]`;
			if (typeof action?.key !== "string" || [...action.key].length !== 1) {
				errors.push(`${at}.key must be one character`);
			} else if ((BUILT_IN_KEYS as readonly string[]).includes(action.key)) {
				errors.push(
					`${at}.key "${action.key}" is one of buncargo's own keys (${BUILT_IN_KEYS.join(" ")})`,
				);
			} else if (keys.has(action.key)) {
				errors.push(`${at}.key "${action.key}" is declared twice`);
			}
			if (typeof action?.key === "string") keys.add(action.key);
			if (typeof action?.label !== "string" || !action.label.trim())
				errors.push(`${at}.label must be a nonempty string`);
			if (!app.captures?.[action?.open])
				errors.push(
					`${at}.open "${String(action?.open)}" is not one of apps.${name}.captures`,
				);
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

		const keyOwners = new Map<string, string>();
		for (const [name, app] of Object.entries(config.apps))
			for (const action of Array.isArray(app.actions) ? app.actions : []) {
				const owner = keyOwners.get(action.key);
				if (owner && owner !== name)
					errors.push(
						`Action key "${action.key}" is declared by both ${owner} and ${name}`,
					);
				keyOwners.set(action.key, name);
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
