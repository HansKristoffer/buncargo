import type { AppConfig, ServiceConfig } from "../../types";
import { inferDockerPreset } from "../service-presets";
import type { RemoteTarget } from "./protocol";
export type SharedTarget = RemoteTarget;
export function sharedTargets(
	apps: Record<string, AppConfig>,
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	serviceNames: readonly string[],
): SharedTarget[] {
	const targets: SharedTarget[] = [];
	for (const [name, app] of Object.entries(apps))
		if (app.kind !== "worker")
			targets.push({
				id: `app-${name}`,
				kind: "app",
				name,
				protocol: app.exposeProtocol ?? "http",
				port: ports[name],
				status: "starting",
			});
	for (const name of serviceNames) {
		const service = services[name];
		if (!service) throw new Error(`Unknown shared service: ${name}`);
		if (service.kind === "job" || service.port === undefined) continue;
		const preset = inferDockerPreset(name, service);
		const protocol =
			service.exposeProtocol ??
			(preset && !["postgres", "redis"].includes(preset) ? "http" : "tcp");
		targets.push({
			id: `service-${name}`,
			kind: "service",
			name,
			protocol,
			port: ports[name],
			status: "ready",
			...(preset ? { preset } : {}),
		});
	}
	for (const target of targets)
		if (
			!Number.isInteger(target.port) ||
			target.port < 1 ||
			target.port > 65535
		)
			throw new Error(`Invalid shared target port: ${target.name}`);
	return targets;
}
