import { execSync } from "node:child_process";
import { isTcpPortOpen } from "../core/network";
import type { BuiltInHealthCheck, HealthCheckFn } from "../types";
import { getComposeCommandPrefix } from "./compose-command";

export interface HealthCheckContext {
	projectName?: string;
	root?: string;
	composeFile?: string;
}

/**
 * Create a health check function from a built-in type.
 */
export function createBuiltInHealthCheck(
	type: BuiltInHealthCheck,
	serviceName: string,
	context: HealthCheckContext = {},
): HealthCheckFn {
	const { projectName, root, composeFile } = context;
	const composeCommandPrefix = getComposeCommandPrefix({
		projectName,
		composeFile,
	});

	function execInService(command: string): boolean {
		try {
			execSync(`${composeCommandPrefix} exec -T ${serviceName} ${command}`, {
				cwd: root,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return true;
		} catch {
			return false;
		}
	}

	switch (type) {
		case "pg_isready":
			return async () => execInService("pg_isready -U postgres");

		case "redis-cli":
			return async () => execInService("redis-cli ping");

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
