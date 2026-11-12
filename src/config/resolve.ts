import { mapValues } from "hanzio";
import { isCI } from "../core/runtime-flags";
import { applySecretDefaults } from "../core/secrets/scope";
import {
	BUILT_IN_SERVICE_ENV_VARS,
	defaultServiceProtocol,
	isDockerPresetName,
} from "../core/service-presets";
import { presetDefinition } from "../docker-compose/services";
import type {
	AppConfig,
	DockerComposeServiceRaw,
	DockerPresetName,
	ResolvedApp,
	ResolvedApps,
	ResolvedDocker,
	ResolvedService,
	ResolvedServices,
	SecretsScopeConfig,
	ServiceConfig,
	ServiceCredentials,
	UrlBuilderFn,
} from "../types";

/** Where a service's ports are published unless it sets `bind`: this machine only. */
const SERVICE_BIND = "127.0.0.1";

/** How long a container gets to become healthy unless it sets `healthTimeout`. */
const SERVICE_HEALTH_TIMEOUT_MS = 30_000;

/** How long an app gets to become ready unless it sets `healthTimeout`. */
function appReadyTimeout(): number {
	return isCI() ? 120_000 : 60_000;
}

/** The fields a config set, without the ones it left `undefined`. */
function definedFields<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, field]) => field !== undefined),
	) as Partial<T>;
}

/**
 * The service as its preset's helper would have written it.
 *
 * A key that names a preset and declares no `docker` (`postgres: { port }`)
 * is `service.postgres({ port })`: the helper's defaults under whatever it
 * set, and portless without a port. Anything else is taken as written.
 */
function expandBarePreset(key: string, service: ServiceConfig): ServiceConfig {
	if (service.docker || service.external || !isDockerPresetName(key))
		return service;
	const helper = presetDefinition(key).toServiceConfig();
	// The ports are the key's own: one without a port stays portless. The
	// preset's env is added with the port, as for the helper's own output.
	const ports =
		service.port === undefined
			? { port: undefined, secondaryPort: undefined }
			: { secondaryPort: helper.secondaryPort };
	return {
		...helper,
		...ports,
		env: undefined,
		...definedFields(service),
	} as ServiceConfig;
}

function resolveDocker(service: ServiceConfig): ResolvedDocker {
	const docker = service.docker;
	if (docker?.kind === "preset")
		return { kind: "preset", preset: docker.preset, override: docker.service };
	const raw: DockerComposeServiceRaw = { ...docker };
	// Compose's own probe is the service's opt-out to drop too, and a job
	// neither restarts nor reports healthy: it exits.
	if (service.kind === "job") raw.restart = "no";
	if (service.healthCheck === false || service.kind === "job")
		delete raw.healthcheck;
	return { kind: "raw", service: raw };
}

function credentialsFor(
	preset: DockerPresetName | undefined,
	service: ServiceConfig,
): ServiceCredentials | undefined {
	const defaults = preset && presetDefinition(preset).credentials;
	if (!defaults) return undefined;
	return {
		user: service.user ?? defaults.user,
		password: service.password ?? defaults.password,
		database: service.database ?? defaults.database,
	};
}

function urlFor(
	preset: DockerPresetName | undefined,
	service: ServiceConfig,
	credentials: ServiceCredentials | undefined,
): UrlBuilderFn {
	if (service.urlTemplate) return service.urlTemplate;
	if (preset) {
		const { url } = presetDefinition(preset);
		return (context) => url({ ...context, credentials });
	}
	return ({ host, port }) => `http://${host}:${port}`;
}

/** The fields of a service with a host port, defaults filled. */
function resolveEndpoint(
	service: ServiceConfig,
	port: number,
	preset: DockerPresetName | undefined,
	credentials: ServiceCredentials | undefined,
) {
	const exposeProtocol =
		service.exposeProtocol ?? defaultServiceProtocol(preset);
	return {
		port,
		secondaryPort: service.secondaryPort,
		bind: service.bind ?? SERVICE_BIND,
		expose: service.expose ?? false,
		exposeProtocol,
		browsable:
			exposeProtocol === "http" && !service.urlTemplate && !credentials,
		healthTimeout: service.healthTimeout ?? SERVICE_HEALTH_TIMEOUT_MS,
		url: urlFor(preset, service, credentials),
	};
}

/**
 * One service as everything that runs it reads it: its preset (its only
 * identity), its kind, and every default filled.
 */
export function resolveService(
	key: string,
	declared: ServiceConfig,
): ResolvedService {
	const service = expandBarePreset(key, declared);
	const serviceName = service.serviceName ?? key;
	const { external } = service;
	if (external) {
		if (service.port === undefined)
			throw new Error(
				`Service "${key}" is provided by stack "${external.stack}" and needs a port`,
			);
		const credentials = credentialsFor(external.preset, service);
		return {
			...resolveEndpoint(service, service.port, external.preset, credentials),
			kind: "external",
			stack: external.stack,
			serviceName,
			preset: external.preset,
			// Its integration decides its env: a second `DATABASE_URL` would
			// collide with the project's own Postgres.
			env: { ...service.env },
			staticEnv: service.staticEnv,
			credentials,
			healthCheck: service.healthCheck ?? false,
			afterPreparation: false,
		};
	}

	const docker = resolveDocker(service);
	const preset = docker.kind === "preset" ? docker.preset : undefined;
	const credentials = credentialsFor(preset, service);
	const base = {
		serviceName,
		preset,
		staticEnv: service.staticEnv,
		credentials,
		docker,
		afterPreparation: service.afterPreparation ?? false,
	};
	const job = service.kind === "job";
	if (service.port === undefined || job)
		return {
			...base,
			kind: job ? "job" : "portless",
			env: { ...service.env },
			expose: false,
			healthCheck: false,
			healthTimeout: service.healthTimeout ?? SERVICE_HEALTH_TIMEOUT_MS,
		};

	// A hand-written `{ kind: "preset" }` gets the helper's probe, as the
	// helper's own output does.
	const presetHealthCheck =
		preset && presetDefinition(preset).toServiceConfig().healthCheck;
	return {
		...base,
		...resolveEndpoint(service, service.port, preset, credentials),
		kind: "container",
		env: {
			...(preset ? BUILT_IN_SERVICE_ENV_VARS[preset] : {}),
			...service.env,
		},
		healthCheck: service.healthCheck ?? presetHealthCheck ?? false,
	};
}

/**
 * One app as everything that runs it reads it: its kind, how it shows it is
 * ready and every default filled.
 */
export function resolveApp(declared: AppConfig): ResolvedApp {
	const {
		kind,
		port,
		devCommand,
		healthEndpoint,
		healthTimeout,
		readyWhen,
		expose,
		exposeProtocol,
		essential,
		extraPorts,
		...fields
	} = declared;
	const base = {
		...fields,
		healthTimeout: healthTimeout ?? appReadyTimeout(),
		essential: essential ?? true,
	};
	const output = readyWhen && { kind: "output" as const, pattern: readyWhen };

	if (kind === "worker")
		return {
			...base,
			kind: "worker",
			expose: false,
			devCommand,
			readiness: output ?? { kind: "alive" },
		};

	const readiness =
		output ??
		(healthEndpoint === false
			? { kind: "none" as const }
			: {
					kind: "http" as const,
					path: healthEndpoint ?? "/",
					declared: healthEndpoint !== undefined,
				});
	const endpoint = {
		port,
		extraPorts: extraPorts ?? [],
		expose: expose ?? false,
		exposeProtocol: exposeProtocol ?? "http",
		readiness,
	};
	return devCommand === false
		? { ...base, ...endpoint, kind: "portOnly", devCommand }
		: { ...base, ...endpoint, kind: "server", devCommand };
}

export function resolveServices<
	TServices extends Record<string, ServiceConfig>,
>(services: TServices): ResolvedServices<TServices> {
	return mapValues(services, (service, key) =>
		resolveService(String(key), service),
	) as ResolvedServices<TServices>;
}

export function resolveApps<TApps extends Record<string, AppConfig>>(
	apps: TApps | undefined,
): ResolvedApps<TApps> {
	return mapValues(apps ?? {}, (app) => resolveApp(app)) as ResolvedApps<TApps>;
}

/**
 * A validated config, integrations applied, with its services and apps
 * resolved: each app's `secrets` scope carries the config-level defaults.
 * Runs once per environment; everything downstream reads this.
 */
export function resolveConfig<
	TConfig extends {
		services: Record<string, ServiceConfig>;
		apps?: Record<string, AppConfig>;
		secrets?: SecretsScopeConfig | false;
	},
>(
	config: TConfig,
): Omit<TConfig, "services" | "apps"> & {
	services: ResolvedServices<TConfig["services"]>;
	apps: ResolvedApps<NonNullable<TConfig["apps"]>>;
} {
	return {
		...config,
		services: resolveServices(config.services),
		apps: applySecretDefaults(resolveApps(config.apps), config.secrets),
	};
}
