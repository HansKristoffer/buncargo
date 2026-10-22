import { typedSwitch } from "hanzio";
import { withDeadline } from "../core/deadline";
import { isTcpPortOpen } from "../core/network";
import type { BuiltInHealthCheck, HealthCheckFn } from "../types";
import type { ContainerRuntimeAdapter } from "./types";

export interface HealthCheckContext {
	runtime: ContainerRuntimeAdapter;
	projectName: string;
	root?: string;
}

/**
 * Create a health check function from a built-in type.
 *
 * The two in-container probes go through the adapter rather than a compose
 * command string, so the same `pg_isready` / `redis-cli ping` contract holds on
 * either backend. `http` and `tcp` probe the published host port and are
 * runtime-independent by construction, except that `tcp` defers to the
 * runtime where a published port accepts before the service listens.
 */
export function createBuiltInHealthCheck(
	type: BuiltInHealthCheck,
	serviceName: string,
	context: HealthCheckContext,
): HealthCheckFn {
	const { runtime, projectName, root } = context;

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
		};
		return runtime.execInService(request);
	}

	return typedSwitch(type, {
		// Ignore the socket-only bootstrap server used while the image initializes.
		pg_isready: () => async (_port, signal) =>
			execInService(
				["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
				signal,
			),

		"redis-cli": () => async (_port, signal) =>
			execInService(["redis-cli", "ping"], signal),

		http: () => async (port, signal) => {
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
		},

		tcp: () => async (port, signal) =>
			runtime.probeServicePort
				? runtime.probeServicePort({
						signal,
						timeoutMs: 1000,
						projectName,
						serviceName,
						hostPort: port,
					})
				: isTcpPortOpen(port, "127.0.0.1", 1000, signal),
	});
}
