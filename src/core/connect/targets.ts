import { isPort } from "../json-shape";
import { matchesProcessIdentity } from "../process-identity";
import type { RunEntry } from "../run-registry";
import { defaultServiceProtocol } from "../service-presets";
import type { TargetInput } from "./protocol";

export interface LocalTarget extends TargetInput {
	pid?: number;
	processIdentity?: string;
}

/** Project the existing registry, excluding local commands and checkout paths. */
export function runTargets(run: RunEntry): LocalTarget[] {
	return [
		...run.apps.flatMap<LocalTarget>((a) => {
			// A worker has no port to reach.
			if (!isPort(a.port)) {
				return [];
			}
			return [
				{
					id: `app-${a.name}`,
					name: a.name,
					kind: "app",
					protocol: a.protocol ?? "http",
					status:
						a.pid && !matchesProcessIdentity(a.pid, a.processIdentity)
							? "stopped"
							: a.status,
					port: a.port,
					pid: a.pid,
					processIdentity: a.processIdentity,
				},
			];
		}),
		...run.services.flatMap<LocalTarget>((s) => {
			if (s.kind === "job" || !isPort(s.port)) {
				return [];
			}
			return [
				{
					id: `service-${s.name}`,
					name: s.name,
					kind: "service",
					protocol: s.protocol ?? defaultServiceProtocol(s.preset),
					status: s.status,
					preset: s.preset,
					port: s.port,
					tablePlusUrl: s.tablePlusUrl,
				},
			];
		}),
	];
}
