import { withDeadline } from "../core/deadline";
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

	async function execInService(
		command: string[],
		signal?: AbortSignal,
	): Promise<boolean> {
		const request = {
			signal,
			timeoutMs: 2000,
			projectName,
			serviceName,
			command,
			root,
			composeFile,
		};
		return runtime.execInServiceAsync
			? runtime.execInServiceAsync(request)
			: runtime.execInService(request);
	}

	switch (type) {
		case "pg_isready":
			return async (_port, signal) =>
				execInService(["pg_isready", "-U", "postgres"], signal);

		case "redis-cli":
			return async (_port, signal) =>
				execInService(["redis-cli", "ping"], signal);

		case "http":
			return async (port, signal) => {
				try {
					return await withDeadline(
						async (probeSignal) => {
							const response = await fetch(`http://localhost:${port}/`, {
								signal: probeSignal,
							});
							const ready = response.ok || response.status === 404;
							await response.body?.cancel();
							return ready;
						},
						2000,
						signal,
					);
				} catch {
					return false;
				}
			};

		case "tcp":
			return async (port, signal) =>
				isTcpPortOpen(port, "127.0.0.1", 1000, signal);

		default: {
			const _exhaustive: never = type;
			return async () => {
				void _exhaustive;
				return true;
			};
		}
	}
}
