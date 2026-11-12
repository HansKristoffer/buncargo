import { typedSwitch, typedSwitchGroup } from "hanzio";
import { envName } from "../../core/ports";
import type {
	BuiltInHealthCheck,
	DockerComposeHealthcheckRaw,
	DockerPresetName,
	HealthCheckFn,
	ResolvedComposeService,
} from "../../types";

const DEFAULT_HEALTHCHECK_SETTINGS = {
	interval: "250ms",
	timeout: "5s",
	retries: 20,
} as const;

/**
 * A value typed into a preset option, written so Compose reads it literally:
 * Compose interpolates every `$` in the file, while the connection URL is
 * built from the raw value.
 */
export function composeLiteral(value: string): string {
	return value.replaceAll("$", () => "$$");
}

function getPortEnvName(portKey: string): string {
	return `${envName(portKey)}_PORT`;
}

function resolveInternalPort(
	preset: DockerPresetName | undefined,
	fallback: number,
): number {
	return typedSwitch(preset, {
		undefined: () => fallback,
		postgres: () => 5432,
		redis: () => 6379,
		clickhouse: () => 8123,
		mailpit: () => 8025,
		typesense: () => 8108,
		minio: () => 9000,
	});
}

function resolveSecondaryInternalPort(
	preset: DockerPresetName | undefined,
	fallback: number,
): number {
	return typedSwitch(preset, {
		clickhouse: () => 9000,
		mailpit: () => 1025,
		...typedSwitchGroup(
			preset,
			[undefined, "postgres", "redis", "typesense", "minio"],
			() => fallback,
		),
	});
}

/** One port buncargo publishes for a service, in both of its forms. */
export interface PortBinding {
	/** The port map key: the service's own, or `<service>Secondary`. */
	portKey: string;
	containerPort: number;
	/** On the claimed host port, through its `<NAME>_PORT` variable. */
	claimed: string;
	/** On a host port the runtime picks (`127.0.0.1::5432`). */
	assigned: string;
}

/**
 * A service's published ports, on its `bind` address. Compose would
 * otherwise publish on every interface, where another machine reaches a
 * database with its default credentials.
 */
export function portBindings(
	serviceKey: string,
	config: ResolvedComposeService,
	preset?: DockerPresetName,
): PortBinding[] {
	if (config.kind !== "container") return [];
	// An IPv6 address is bracketed, so its colons do not split the entry.
	const host = config.bind.includes(":") ? `[${config.bind}]` : config.bind;
	const binding = (
		portKey: string,
		hostPort: number,
		containerPort: number,
	): PortBinding => ({
		portKey,
		containerPort,
		claimed: `${host}:\${${getPortEnvName(portKey)}:-${hostPort}}:${containerPort}`,
		assigned: `${host}::${containerPort}`,
	});
	const bindings = [
		binding(serviceKey, config.port, resolveInternalPort(preset, config.port)),
	];
	if (config.secondaryPort !== undefined)
		bindings.push(
			binding(
				`${serviceKey}Secondary`,
				config.secondaryPort,
				resolveSecondaryInternalPort(preset, config.secondaryPort),
			),
		);
	return bindings;
}

/** A service's `ports` entries on its claimed host ports. */
export function getDefaultPortBindings(
	serviceKey: string,
	config: ResolvedComposeService,
	preset?: DockerPresetName,
): string[] {
	return portBindings(serviceKey, config, preset).map(({ claimed }) => claimed);
}

export function resolveHealthcheck(
	healthCheck: BuiltInHealthCheck | HealthCheckFn | false,
	fallback: DockerComposeHealthcheckRaw | undefined,
	options: { internalPort: number; user?: string },
): DockerComposeHealthcheckRaw | undefined {
	if (healthCheck === false) return undefined;
	if (typeof healthCheck === "function") return fallback;
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
