import type { AppConfig, ServiceConfig } from "../types";
import { assertOnlyAppNames, pickApps } from "./app-selection";

export interface AppSelectionPlan {
	appNames: string[];
	apps: Record<string, AppConfig>;
}

export interface StartPlan extends AppSelectionPlan {
	requiredServiceKeys: string[];
	composeServiceNames: string[];
}

export function getComposeServiceName(
	services: Record<string, ServiceConfig>,
	serviceKey: string,
): string {
	const service = services[serviceKey];
	if (!service) {
		throw new Error(`Unknown service key "${serviceKey}"`);
	}
	return service.serviceName ?? serviceKey;
}

export function resolveComposeServiceNames(
	services: Record<string, ServiceConfig>,
	serviceKeys: string[],
): string[] {
	return serviceKeys.map((serviceKey) =>
		getComposeServiceName(services, serviceKey),
	);
}

export function resolveSelectedApps(
	apps: Record<string, AppConfig>,
	onlyApps: string[] | undefined,
): AppSelectionPlan {
	assertOnlyAppNames(Object.keys(apps), onlyApps);

	const requestedAppNames = onlyApps ?? Object.keys(apps);
	const visitState = new Map<string, "visiting" | "visited">();
	const visitStack: string[] = [];
	const resolvedAppNames: string[] = [];

	function visit(appName: string): void {
		const state = visitState.get(appName);
		if (state === "visited") return;
		if (state === "visiting") {
			const cycleStartIndex = visitStack.indexOf(appName);
			const cycle = visitStack.slice(cycleStartIndex).concat(appName);
			throw new Error(
				`Circular requiredApps dependency: ${cycle.join(" -> ")}`,
			);
		}

		const app = apps[appName];
		if (!app) {
			throw new Error(`Unknown app name(s) in onlyApps: ${appName}`);
		}

		visitState.set(appName, "visiting");
		visitStack.push(appName);

		for (const dependencyName of app.requiredApps ?? []) {
			if (!apps[dependencyName]) {
				throw new Error(
					`App "${appName}" requires unknown app "${dependencyName}"`,
				);
			}
			visit(dependencyName);
		}

		visitStack.pop();
		visitState.set(appName, "visited");
		resolvedAppNames.push(appName);
	}

	for (const appName of requestedAppNames) {
		visit(appName);
	}

	return {
		appNames: resolvedAppNames,
		apps: pickApps(apps, resolvedAppNames),
	};
}

export function resolveRequiredServiceKeys(
	apps: Record<string, AppConfig>,
	services: Record<string, ServiceConfig>,
	appNames: string[],
): string[] {
	const resolvedServiceKeys: string[] = [];
	const seenServiceKeys = new Set<string>();

	for (const appName of appNames) {
		const app = apps[appName];
		if (!app) {
			throw new Error(`Unknown app "${appName}" in resolved start plan`);
		}

		for (const serviceKey of app.requiredServices ?? []) {
			if (!services[serviceKey]) {
				throw new Error(
					`App "${appName}" requires unknown service "${serviceKey}"`,
				);
			}
			if (seenServiceKeys.has(serviceKey)) continue;
			seenServiceKeys.add(serviceKey);
			resolvedServiceKeys.push(serviceKey);
		}
	}

	return resolvedServiceKeys;
}

export function buildStartPlan(
	apps: Record<string, AppConfig>,
	services: Record<string, ServiceConfig>,
	onlyApps: string[] | undefined,
): StartPlan {
	const selection = resolveSelectedApps(apps, onlyApps);
	const requiredServiceKeys = resolveRequiredServiceKeys(
		apps,
		services,
		selection.appNames,
	);

	if (requiredServiceKeys.length === 0) {
		const selectionLabel =
			selection.appNames.length > 0 ? selection.appNames.join(", ") : "(none)";
		throw new Error(
			`No required services resolved for app selection: ${selectionLabel}. Add requiredServices to the selected apps or their requiredApps.`,
		);
	}

	return {
		...selection,
		requiredServiceKeys,
		composeServiceNames: resolveComposeServiceNames(
			services,
			requiredServiceKeys,
		),
	};
}
