import { typedSwitch, typedSwitchGroup } from "hanzio";
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
	return typedSwitch(preset, {
		postgres: () => 5432,
		redis: () => 6379,
		clickhouse: () => 8123,
		mailpit: () => 8025,
		typesense: () => 8108,
	});
}

function resolveSecondaryInternalPort(
	preset: DockerPresetName | undefined,
	fallback: number,
): number {
	if (!preset) return fallback;
	return typedSwitch(preset, {
		clickhouse: () => 9000,
		mailpit: () => 1025,
		...typedSwitchGroup(
			preset,
			["postgres", "redis", "typesense"],
			() => fallback,
		),
	});
}

export function getDefaultPortBindings(
	serviceKey: string,
	config: ServiceConfig,
	preset?: DockerPresetName,
): string[] {
	if (config.port === undefined) return [];
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

	return typedSwitch(healthCheck, {
		// The image's bootstrap server accepts Unix sockets before TCP is ready.
		pg_isready: () => ({
			test: [
				"CMD-SHELL",
				`pg_isready -h 127.0.0.1 -U ${options.user ?? "postgres"}`,
			],
			...DEFAULT_HEALTHCHECK_SETTINGS,
		}),
		"redis-cli": () => ({
			test: ["CMD", "redis-cli", "ping"],
			...DEFAULT_HEALTHCHECK_SETTINGS,
		}),
		http: () => ({
			test: [
				"CMD-SHELL",
				`wget -qO- http://127.0.0.1:${options.internalPort}/ping || exit 1`,
			],
			...DEFAULT_HEALTHCHECK_SETTINGS,
		}),
		// A TCP connect is what buncargo's own readiness poll does from the host
		// (`isTcpPortOpen`). There is no portable in-container equivalent - `nc`
		// and `/dev/tcp` are both missing from common base images - so emit no
		// compose healthcheck rather than the preset's, which the caller opted out of.
		tcp: () => undefined,
	});
}
