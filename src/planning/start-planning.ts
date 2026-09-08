import type { AppConfig, DockerComposeNode, ServiceConfig } from "../types";
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
		if (state === "visited") {
			return;
		}

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

			if (seenServiceKeys.has(serviceKey)) {
				continue;
			}
			seenServiceKeys.add(serviceKey);
			resolvedServiceKeys.push(serviceKey);
		}
	}

	return resolveServiceDependencies(services, resolvedServiceKeys);
}

/** Normalize Compose's short and long forms before walking dependency edges. */
function readServiceDependencies(
	serviceName: string,
	service: ServiceConfig | undefined,
): [string, DockerComposeNode | undefined][] {
	const docker = service?.docker;
	const raw = docker?.kind === "preset" ? docker.service : docker;
	const dependencies = raw?.depends_on;

	if (dependencies === undefined) {
		return [];
	}

	if (Array.isArray(dependencies)) {
		if (dependencies.some((name) => typeof name !== "string")) {
			throw new Error(
				`Service "${serviceName}" has malformed Compose depends_on`,
			);
		}

		return dependencies.map((name) => [name, undefined]);
	}

	if (dependencies === null || typeof dependencies !== "object") {
		throw new Error(
			`Service "${serviceName}" has malformed Compose depends_on`,
		);
	}

	return Object.entries(dependencies).map(([name, definition]) => {
		if (
			definition !== undefined &&
			(definition === null ||
				typeof definition !== "object" ||
				Array.isArray(definition))
		) {
			throw new Error(
				`Service "${serviceName}" has malformed dependency on "${name}"`,
			);
		}

		const condition = definition?.condition;
		if (
			condition !== undefined &&
			![
				"service_started",
				"service_healthy",
				"service_completed_successfully",
			].includes(String(condition))
		) {
			throw new Error(
				`Service "${serviceName}" has invalid dependency condition for "${name}"`,
			);
		}

		return [name, condition];
	});
}

/** Expand and validate Compose dependencies without resolving a runtime or model. */
export function resolveServiceDependencies(
	services: Record<string, ServiceConfig>,
	keys: string[],
): string[] {
	const resolvedServiceKeys = [...keys];
	const seenServiceKeys = new Set(keys);

	// Compose dependencies are also selected resources, including aliases.
	const byComposeName = new Map(
		Object.entries(services).map(([key, service]) => [
			service.serviceName ?? key,
			key,
		]),
	);
	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visitDependency(key: string): void {
		if (visited.has(key)) {
			return;
		}

		if (visiting.has(key)) {
			throw new Error(`Circular Compose dependency at service "${key}"`);
		}

		visiting.add(key);

		for (const [name, condition] of readServiceDependencies(
			key,
			services[key],
		)) {
			const dependency = byComposeName.get(name);
			if (!dependency) {
				throw new Error(
					`Service "${key}" depends on unknown Compose service "${name}"`,
				);
			}

			if (
				condition === "service_completed_successfully" &&
				services[dependency]?.kind !== "job"
			) {
				throw new Error(
					`Service "${key}" requires completion of "${dependency}", which must declare kind: "job"`,
				);
			}

			if (
				condition === "service_healthy" &&
				services[dependency]?.kind === "job"
			) {
				throw new Error(
					`Service "${key}" requires health from job "${dependency}"; use service_completed_successfully`,
				);
			}

			// An early service cannot wait for something intentionally started later.
			if (
				!services[key]?.afterPreparation &&
				services[dependency]?.afterPreparation
			) {
				throw new Error(
					`Service "${key}" depends on afterPreparation service "${dependency}" before preparation`,
				);
			}

			if (!seenServiceKeys.has(dependency)) {
				seenServiceKeys.add(dependency);
				resolvedServiceKeys.push(dependency);
			}

			visitDependency(dependency);
		}

		visiting.delete(key);
		visited.add(key);
	}

	for (const key of keys) {
		visitDependency(key);
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

	return {
		...selection,
		requiredServiceKeys,
		composeServiceNames: resolveComposeServiceNames(
			services,
			requiredServiceKeys,
		),
	};
}
