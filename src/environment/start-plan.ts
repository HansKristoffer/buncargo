import { planStart, type StartPlan } from "../planning";
import type { AppConfig, ServiceConfig } from "../types";

type Source = {
	apps: Record<string, AppConfig>;
	services: Record<string, ServiceConfig>;
};
const planners = new WeakMap<
	object,
	(onlyApps?: string[], onlyServices?: readonly string[]) => StartPlan
>();
export function registerStartPlanner(
	source: object,
	planner: (onlyApps?: string[], onlyServices?: readonly string[]) => StartPlan,
): void {
	planners.set(source, planner);
}
export function environmentStartPlan(
	source: Source,
	onlyApps?: string[],
	onlyServices?: readonly string[],
): StartPlan {
	return (
		planners.get(source)?.(onlyApps, onlyServices) ??
		planStart(source.apps, source.services, { onlyApps, onlyServices })
	);
}
