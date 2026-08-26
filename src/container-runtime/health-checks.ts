import { isTcpPortOpen } from "../core/network";
import type { BuiltInHealthCheck, HealthCheckFn } from "../types";
import type { ContainerRuntimeAdapter } from "./types";

export interface HealthCheckContext {
	runtime: ContainerRuntimeAdapter;
	projectName: string;
	root?: string;
	composeFile?: string;
}

/**
 * Create a health check function from a built-in type.
 *
 * The two in-container probes go through the adapter rather than a compose
 * command string, so the same `pg_isready` / `redis-cli ping` contract holds on
 * either backend. `http` and `tcp` probe the published host port and are
 * runtime-independent by construction.
 */
export function createBuiltInHealthCheck(
	type: BuiltInHealthCheck,
	serviceName: string,
	context: HealthCheckContext,
): HealthCheckFn {
	const { runtime, projectName, root, composeFile } = context;

	function execInService(command: string[]): boolean {
		return runtime.execInService({
			projectName,
			serviceName,
			command,
			root,
			composeFile,
		});
	}

	switch (type) {
		case "pg_isready":
			return async () => execInService(["pg_isready", "-U", "postgres"]);

		case "redis-cli":
			return async () => execInService(["redis-cli", "ping"]);

		case "http":
			return async (port) => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 2000);
				try {
					const response = await fetch(`http://localhost:${port}/`, {
						signal: controller.signal as RequestInit["signal"],
					});
					return response.ok || response.status === 404;
				} catch {
					return false;
				} finally {
					clearTimeout(timeoutId);
				}
			};

		case "tcp":
			return async (port) => isTcpPortOpen(port);

		default: {
			const _exhaustive: never = type;
			return async () => {
				void _exhaustive;
				return true;
			};
		}
	}
}
