import type {
	DockerComposeHealthcheckRaw,
	DockerPresetName,
	ServiceConfig,
} from "../../types";

const DEFAULT_HEALTHCHECK_SETTINGS = {
	interval: "250ms",
	timeout: "5s",
	retries: 20,
} as const;

export function getPortEnvName(portKey: string): string {
	return `${portKey.toUpperCase()}_PORT`;
}

function resolveInternalPort(
	preset: DockerPresetName | undefined,
	fallback: number,
): number {
	if (!preset) return fallback;
	switch (preset) {
		case "postgres":
			return 5432;
		case "redis":
			return 6379;
		case "clickhouse":
			return 8123;
		case "mailpit":
			return 8025;
		case "typesense":
			return 8108;
		default: {
			const _exhaustive: never = preset;
			return _exhaustive;
		}
	}
}

function resolveSecondaryInternalPort(
	preset: DockerPresetName | undefined,
	fallback: number,
): number {
	if (!preset) return fallback;
	switch (preset) {
		case "clickhouse":
			return 9000;
		case "mailpit":
			return 1025;
		case "postgres":
		case "redis":
		case "typesense":
			return fallback;
		default: {
			const _exhaustive: never = preset;
			return _exhaustive;
		}
	}
}

export function getDefaultPortBindings(
	serviceKey: string,
	config: ServiceConfig,
	preset?: DockerPresetName,
): string[] {
	const envName = getPortEnvName(serviceKey);
	const bindings: string[] = [];

	const defaultInternalPort = resolveInternalPort(preset, config.port);

	bindings.push(`\${${envName}:-${config.port}}:${defaultInternalPort}`);

	if (config.secondaryPort !== undefined) {
		const secondaryEnv = getPortEnvName(`${serviceKey}Secondary`);
		const secondaryInternal = resolveSecondaryInternalPort(
			preset,
			config.secondaryPort,
		);
		bindings.push(
			`\${${secondaryEnv}:-${config.secondaryPort}}:${secondaryInternal}`,
		);
	}

	return bindings;
}

export function resolveHealthcheck(
	healthCheck: ServiceConfig["healthCheck"] | undefined,
	fallback: DockerComposeHealthcheckRaw | undefined,
	options: { internalPort: number; user?: string },
): DockerComposeHealthcheckRaw | undefined {
	if (healthCheck === false) return undefined;
	if (typeof healthCheck === "function") return fallback;
	if (!healthCheck) return fallback;

	switch (healthCheck) {
		case "pg_isready":
			return {
				test: ["CMD-SHELL", `pg_isready -U ${options.user ?? "postgres"}`],
				...DEFAULT_HEALTHCHECK_SETTINGS,
			};
		case "redis-cli":
			return {
				test: ["CMD", "redis-cli", "ping"],
				...DEFAULT_HEALTHCHECK_SETTINGS,
			};
		case "http":
			return {
				test: [
					"CMD-SHELL",
					`wget -qO- http://127.0.0.1:${options.internalPort}/ping || exit 1`,
				],
				...DEFAULT_HEALTHCHECK_SETTINGS,
			};
		case "tcp":
			// A TCP connect is what buncargo's own readiness poll does from the host
			// (`isTcpPortOpen`). There is no portable in-container equivalent - `nc`
			// and `/dev/tcp` are both missing from common base images - so emit no
			// compose healthcheck rather than the preset's, which the caller opted out of.
			return undefined;
		default: {
			const _exhaustive: never = healthCheck;
			void _exhaustive;
			return fallback;
		}
	}
}
