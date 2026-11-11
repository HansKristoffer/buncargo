import type { AppConfig, AppOptions } from "./app";
import type { DevConfig, EnvValues } from "./config";
import type {
	BuiltInHealthCheck,
	DockerComposeServiceRaw,
	DockerPresetName,
	HealthCheckFn,
	ServiceConfig,
	ServiceEnvValueSource,
	UrlBuilderFn,
} from "./service";

// ═══════════════════════════════════════════════════════════════════════════
// Resolved Config
//
// What `resolveConfig` turns a validated config's services and apps into:
// one variant per kind, every default filled. Everything that runs a config
// reads these, so a default is decided once and a kind is a union member
// rather than a combination of optional fields.
// ═══════════════════════════════════════════════════════════════════════════

/** How a resolved app shows it is ready. */
export type AppReadiness =
	/**
	 * Its port answers HTTP at `path`. `declared`: the config named the path,
	 * so any status but a 2xx/3xx fails it and a port already held by another
	 * process is asked before it is reused. The default `/` takes any answer.
	 */
	| { kind: "http"; path: string; declared: boolean }
	/** Its output matches `pattern` (`readyWhen`). */
	| { kind: "output"; pattern: RegExp }
	/** A worker: spawned and still alive. */
	| { kind: "alive" }
	/** Nothing to wait for (`healthEndpoint: false`). */
	| { kind: "none" };

/** The fields every resolved app carries as the config declared them. */
type ResolvedAppFields = Omit<
	AppOptions,
	| "devCommand"
	| "healthEndpoint"
	| "healthTimeout"
	| "readyWhen"
	| "expose"
	| "exposeProtocol"
	| "essential"
	| "extraPorts"
>;

interface ResolvedAppBase extends ResolvedAppFields {
	/** How long it gets to become ready, in milliseconds. */
	healthTimeout: number;
	/** Whether the run ends when it exits. */
	essential: boolean;
}

interface ResolvedEndpoint {
	port: number;
	extraPorts: readonly number[];
	expose: boolean;
	exposeProtocol: "http" | "tcp";
}

/** An app with a port and a dev process. */
export interface ResolvedServerApp extends ResolvedAppBase, ResolvedEndpoint {
	kind: "server";
	devCommand: string;
	readiness: Exclude<AppReadiness, { kind: "alive" }>;
}

/** An app with a dev process and no port. */
export interface ResolvedWorkerApp extends ResolvedAppBase {
	kind: "worker";
	port?: undefined;
	extraPorts?: undefined;
	expose: false;
	devCommand: string;
	readiness: Extract<AppReadiness, { kind: "output" | "alive" }>;
}

/**
 * An app whose port buncargo reserves (and tunnels) without starting
 * anything in dev: `devCommand: false`. Its readiness applies to a
 * production build's `prodCommand`.
 */
export interface ResolvedPortOnlyApp extends ResolvedAppBase, ResolvedEndpoint {
	kind: "portOnly";
	devCommand: false;
	readiness: Exclude<AppReadiness, { kind: "alive" }>;
}

export type ResolvedApp =
	ResolvedServerApp | ResolvedWorkerApp | ResolvedPortOnlyApp;

/** A preset's user, password and database, defaults filled. */
export interface ServiceCredentials {
	user: string;
	password: string;
	database: string;
}

/** Where a container's Compose service comes from. */
export type ResolvedDocker =
	| {
			kind: "preset";
			preset: DockerPresetName;
			/** Raw Compose fields merged over the preset's. */
			override?: DockerComposeServiceRaw;
	  }
	| { kind: "raw"; service: DockerComposeServiceRaw };

interface ResolvedServiceBase {
	/** The Compose service name: `serviceName`, else the key. */
	serviceName: string;
	/** The built-in preset it is; undefined for a custom container. */
	preset: DockerPresetName | undefined;
	/** The env vars it derives, the preset's and its own `env`, by name. */
	env: Readonly<Record<string, ServiceEnvValueSource>>;
	staticEnv?: EnvValues;
}

interface ResolvedServiceEndpoint {
	port: number;
	secondaryPort?: number;
	expose: boolean;
	exposeProtocol: "http" | "tcp";
	healthCheck: BuiltInHealthCheck | HealthCheckFn | false;
	/** How long it gets to become healthy, in milliseconds. */
	healthTimeout: number;
	/** Its connection URL on a port and host. */
	url: UrlBuilderFn;
	/** Set for presets whose URL carries credentials. */
	credentials?: ServiceCredentials;
	/**
	 * A page a browser can open: HTTP, with no custom `urlTemplate` and no
	 * credentials in its URL. Only these get a named host and an `↗`.
	 */
	browsable: boolean;
}

/** A container this config's Compose file runs, with a host port. */
export interface ResolvedContainerService
	extends ResolvedServiceBase, ResolvedServiceEndpoint {
	kind: "container";
	docker: ResolvedDocker;
	afterPreparation: boolean;
}

/** A container with no host endpoint: ready when its process is up. */
export interface ResolvedPortlessService extends ResolvedServiceBase {
	kind: "portless";
	port?: undefined;
	secondaryPort?: undefined;
	expose: false;
	healthCheck: false;
	healthTimeout: number;
	credentials?: ServiceCredentials;
	docker: ResolvedDocker;
	afterPreparation: boolean;
}

/** A container run to completion on every start. */
export interface ResolvedJobService extends ResolvedServiceBase {
	kind: "job";
	port?: undefined;
	secondaryPort?: undefined;
	expose: false;
	healthCheck: false;
	healthTimeout: number;
	credentials?: ServiceCredentials;
	docker: ResolvedDocker;
	afterPreparation: boolean;
}

/** Run by an integration's stack; buncargo only allocates its port. */
export interface ResolvedExternalService
	extends ResolvedServiceBase, ResolvedServiceEndpoint {
	kind: "external";
	/** The stack's key in its integration's `stacks`. */
	stack: string;
	afterPreparation: false;
}

export type ResolvedService =
	| ResolvedContainerService
	| ResolvedPortlessService
	| ResolvedJobService
	| ResolvedExternalService;

/** A service the generated Compose file runs. */
export type ResolvedComposeService = Exclude<
	ResolvedService,
	ResolvedExternalService
>;

/** A config's services, resolved, keyed as declared. */
export type ResolvedServices<TServices = Record<string, unknown>> = {
	[K in keyof TServices]: ResolvedService;
};

/** A config's apps, resolved, keyed as declared. */
export type ResolvedApps<TApps = Record<string, unknown>> = {
	[K in keyof TApps]: ResolvedApp;
};

/**
 * A config with its integrations applied, validated, and its services and
 * apps resolved: what a dev environment holds. `TServices` and `TApps` stay
 * the declared ones, for the computed key types.
 */
export type ResolvedDevConfig<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> = Omit<DevConfig<TServices, TApps, TEnv>, "services" | "apps"> & {
	services: ResolvedServices<TServices>;
	apps: ResolvedApps<TApps>;
};
