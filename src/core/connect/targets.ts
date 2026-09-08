import type { AppConfig, ServiceConfig } from "../../types";
import { inferDockerPreset } from "../service-presets";
import { type RemoteTarget, validPort } from "./protocol";
/** Select only this run's endpoints, using resolved worktree ports rather than config defaults. */
export function sharedTargets(
	apps: Record<string, AppConfig>,
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	serviceNames: readonly string[],
): RemoteTarget[] {
	const targets: RemoteTarget[] = [];
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
		if (!validPort(target.port))
			throw new Error(`Invalid shared target port: ${target.name}`);
	return targets;
}
