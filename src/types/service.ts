import type { EnvValues } from "./config";

// ═══════════════════════════════════════════════════════════════════════════
// Service Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Health check function signature for custom health checks.
 */
export type HealthCheckFn = (
	port: number,
	signal?: AbortSignal,
) => Promise<boolean>;

/**
 * Built-in health check types that map to common patterns.
 */
export type BuiltInHealthCheck = "pg_isready" | "redis-cli" | "http" | "tcp";

/**
 * URL builder context passed to urlTemplate function.
 */
export interface UrlBuilderContext {
	port: number;
	secondaryPort?: number;
	host: string;
	localIp: string;
}

/**
 * URL builder function receives port info and returns the connection URL.
 */
export type UrlBuilderFn = (ctx: UrlBuilderContext) => string;

// ═══════════════════════════════════════════════════════════════════════════
// Docker Compose Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursive YAML-safe value used for Docker Compose objects.
 */
export type DockerComposeNode =
	| string
	| number
	| boolean
	| null
	| DockerComposeNode[]
	| { [key: string]: DockerComposeNode | undefined };

/**
 * Supported sources for service-derived environment variables.
 */
export type ServiceEnvValueSource = "url" | "port" | "secondaryPort";

/**
 * Declared env var outputs for a service.
 */
export type ServiceEnvVarMap = Record<string, ServiceEnvValueSource>;

/**
 * Built-in env var aliases exposed by preset services.
 *
 * This is the canonical list of built-in presets: {@link DockerPresetName} is
 * its key set, and both the runtime env map and the compose builder registry
 * are pinned to it with `satisfies`.
 */
export interface BuiltInServiceEnvVarMap {
	postgres: {
		DATABASE_URL: "url";
	};
	redis: {
		REDIS_URL: "url";
	};
	clickhouse: {
		CLICKHOUSE_URL: "url";
		CLICKHOUSE_NATIVE_PORT: "secondaryPort";
	};
	mailpit: {
		MAILPIT_URL: "url";
		SMTP_PORT: "secondaryPort";
	};
	typesense: {
		TYPESENSE_URL: "url";
	};
}

/**
 * Built-in Docker service presets.
 */
export type DockerPresetName = keyof BuiltInServiceEnvVarMap;

/**
 * Docker Compose healthcheck object.
 */
export interface DockerComposeHealthcheckRaw {
	test?: string[] | string;
	interval?: string;
	timeout?: string;
	retries?: number;
	start_period?: string;
	disable?: boolean;
	[composeKey: string]: DockerComposeNode | undefined;
}

/**
 * Docker Compose service (raw escape hatch).
 * Includes common fields plus index signature for advanced keys.
 */
export interface DockerComposeServiceRaw {
	/**
	 * Never set. Present so {@link DockerServiceDefinition} is a discriminated
	 * union: without it the index signature below would give `kind` a type that
	 * overlaps `"preset"`, and `docker.kind === "preset"` would not narrow.
	 */
	kind?: never;
	image?: string;
	container_name?: string;
	ports?: string[];
	volumes?: string[];
	environment?: Record<string, string | number | boolean>;
	command?: string | string[];
	entrypoint?: string | string[];
	depends_on?: string[] | Record<string, DockerComposeNode>;
	healthcheck?: DockerComposeHealthcheckRaw;
	ulimits?: Record<string, number | { soft: number; hard: number }>;
	restart?: string;
	working_dir?: string;
	[composeKey: string]: DockerComposeNode | undefined;
}

/**
 * Docker Compose volume object.
 */
export interface DockerComposeVolumeRaw {
	driver?: string;
	driver_opts?: Record<string, string | number | boolean>;
	[composeKey: string]: DockerComposeNode | undefined;
}

/**
 * The generated compose model: every service resolved, before serialization.
 *
 * Both backends consume this - Docker via the YAML rendered from it, Apple by
 * walking it directly - so it is the one description of a project's stack.
 */
export type ComposeDocument = {
	name?: string;
	services: Record<string, DockerComposeServiceRaw>;
	volumes?: Record<string, DockerComposeVolumeRaw>;
};

/** Identity stamped onto every generated service as buncargo labels. */
export interface ComposeIdentity {
	projectName: string;
	root: string;
	worktree?: string | null;
}

/**
 * Helper-friendly preset service definition.
 */
export interface DockerPresetServiceDefinition {
	kind: "preset";
	preset: DockerPresetName;
	service?: DockerComposeServiceRaw;
}

/**
 * Docker service definition accepted by service config.
 *
 * Discriminated on `kind`: the `service.<preset>()` helpers return `kind:
 * "preset"`, while a raw Compose object (the manual escape hatch) never carries
 * `kind`. Narrow with `docker.kind === "preset"`.
 */
export type DockerServiceDefinition =
	| DockerComposeServiceRaw
	| DockerPresetServiceDefinition;

/**
 * One buncargo-labeled container, as reported by whichever runtime owns it.
 *
 * Both backends fill this from their own inventory command, so `ls`, `status`,
 * `doctor` and `stop-all` render identically no matter which one is active.
 */
export interface BuncargoContainer {
	id: string;
	name: string;
	/**
	 * The runtime's own word for the state: `running`, `exited`, `paused`.
	 *
	 * Distinct from {@link BuncargoContainer.status}, which is for people:
	 * deciding anything from `Up 3 minutes` means parsing prose, and the
	 * sweep's "every container is stopped" rule hangs off this answer.
	 */
	state: string;
	/** The runtime's human-readable status line, for display only. */
	status: string;
	ports: string;
	project: string;
	root: string;
	worktree: string;
	service: string;
	/** Which runtime reported it; set so `stop-all` can stop each with its own. */
	runtime?: ContainerRuntimeName;
}

/**
 * A volume a runtime is holding, as far as its listing can say.
 *
 * `project` comes from Compose's own label. Buncargo deliberately adds no
 * labels of its own here: Compose compares a volume's configuration against
 * the file and prompts "exists but doesn't match configuration in compose
 * file. Recreate (data will be lost)?" — which hangs a non-interactive run and
 * offers to destroy a database. Whatever prune knows about a volume, it has to
 * learn without touching the volume's definition.
 */
export interface BuncargoVolume {
	name: string;
	/** Compose project, where the runtime records one. */
	project?: string;
	runtime: ContainerRuntimeName;
}

/** A container holding a host port, as far as a runtime can tell. */
export interface PortContainerOwner {
	id: string;
	name: string;
	composeProject?: string;
	/**
	 * Which backend reported it.
	 *
	 * Set when the owner was found outside the runtime this project selected,
	 * so the message can say "a Docker container is holding it" rather than
	 * naming the daemon process that happens to hold the socket.
	 */
	runtime?: ContainerRuntimeName;
}

/**
 * Container runtime backend that runs the generated service model.
 *
 * `"docker"` drives `docker compose`; `"apple"` translates the same model into
 * Apple `container` invocations (macOS on Apple silicon only).
 */
export type ContainerRuntimeName = "docker" | "apple";

/**
 * Runtime selection accepted from config, env and CLI.
 *
 * `"auto"` prefers Apple `container` when its system service answers, and
 * falls back to Docker otherwise.
 */
export type ContainerRuntimeSelection = ContainerRuntimeName | "auto";

/**
 * Docker Compose generation configuration.
 */
export interface DockerComposeGenerationOptions {
	/** Path to generated compose file relative to root. Default: '.buncargo/docker-compose.generated.yml' */
	generatedFile?: string;
	/** Write strategy for generated compose file. Default: 'always' */
	writeStrategy?: "always" | "if-missing";
	/** Extra top-level named volumes */
	volumes?: Record<string, DockerComposeVolumeRaw>;
	/** Auto-start Docker if the daemon is down. Default: true (skipped in CI) */
	autoStart?: boolean;
	/** Container runtime backend. Default: 'docker' */
	runtime?: ContainerRuntimeSelection;
	/** Absolute path to the runtime binary, overriding the PATH lookup */
	binary?: string;
}

/**
 * Configuration for a Docker Compose service (e.g., postgres, redis).
 */
export interface ServiceConfigBase<
	TEnv extends ServiceEnvVarMap = ServiceEnvVarMap,
	TStatic extends EnvValues = EnvValues,
> {
	/** Base host port; omit for a container with no published endpoint. */
	port?: number;
	/**
	 * Opt into public URLs with --expose.
	 * @deprecated frp sharing automatically includes all selected endpoints with a host port.
	 * This option only controls public tunnels started with --expose.
	 */
	expose?: boolean;
	/** Protocol for recipient sharing; apps default to HTTP, presets infer it, custom services default to TCP. */
	exposeProtocol?: "http" | "tcp";
	/** Optional secondary port (e.g., ClickHouse native protocol) */
	secondaryPort?: number;
	/** Health check: built-in name, custom function, or disabled (false) */
	healthCheck?: BuiltInHealthCheck | HealthCheckFn | false;
	/** Timeout for service health polling in milliseconds. Default: 30000 */
	healthTimeout?: number;
	/** URL builder function that returns the connection URL */
	urlTemplate?: UrlBuilderFn;
	/** Docker Compose service name (defaults to the key name) */
	serviceName?: string;

	// ─────────────────────────────────────────────────────────────────────────
	// Built-in URL template options (alternative to urlTemplate)
	// When these are set, a built-in URL template is used based on the service name
	// ─────────────────────────────────────────────────────────────────────────

	/** Database name (for postgres, mysql, clickhouse). Enables built-in URL template. */
	database?: string;
	/** Username (default: 'postgres' for postgres, 'root' for mysql, 'default' for clickhouse) */
	user?: string;
	/** Password (default: 'postgres' for postgres, 'root' for mysql, 'clickhouse' for clickhouse) */
	password?: string;
	/** Explicit env vars this service contributes to the shared env surface */
	env?: TEnv;
	/** Constant values merged into the shared env (e.g. SMTP_HOST, API keys) */
	staticEnv?: TStatic;
	/** Start after database preparation/seed. Its Compose dependencies must be ready first. */
	afterPreparation?: boolean;
	/** Docker Compose service definition (preset helper or raw escape hatch) */
	docker?: DockerServiceDefinition;
	/**
	 * Provided by an integration's stack (`BuncargoIntegration.stacks`) instead
	 * of the generated Compose file: buncargo allocates its port, URL and env,
	 * and starts the stack when the service is selected.
	 */
	external?: ExternalServiceConfig;
}

/** See {@link ServiceConfigBase.external}. */
export interface ExternalServiceConfig {
	/** The stack's key in its integration's `stacks`. */
	stack: string;
	/** What it is, for TablePlus links and the like; it adds no default env. */
	preset?: DockerPresetName;
}

/** Portless containers have no host endpoint. Jobs require an explicit rerun policy. */
export type ServiceConfig<
	TEnv extends ServiceEnvVarMap = ServiceEnvVarMap,
	TStatic extends EnvValues = EnvValues,
> = ServiceConfigBase<TEnv, TStatic> &
	(
		| { kind?: "service"; rerun?: never }
		| {
				kind: "job";
				rerun: "always";
				port?: never;
				secondaryPort?: never;
				healthCheck?: never;
				expose?: never;
				urlTemplate?: never;
		  }
	);
