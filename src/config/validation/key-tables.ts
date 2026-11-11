import type {
	AppConfig,
	AppOptions,
	AppWatchConfig,
	CaptureConfig,
	DevConfig,
	DevOptions,
	DockerComposeGenerationOptions,
	EnvFileOptions,
	HostsOptions,
	PrismaConfig,
	ProfileConfig,
	SecretsScopeConfig,
	SeedConfig,
	ServiceConfig,
	ServiceConfigBase,
	TaskConfig,
} from "../../types";

/**
 * How a key's value is checked: a `typeof` the shape checks apply as is, a
 * positive duration in milliseconds, or `"shape"` for a value its own check
 * reads in full.
 */
export type FieldCheck =
	"boolean" | "string" | "function" | "duration" | "shape";

/**
 * One table per config section: every key the section takes, pinned to its
 * type with `satisfies`, so a field added to the type and not here (or left
 * here after it is removed) fails to compile. The tables drive both the
 * per-field checks and the unknown-key errors.
 */
export const CONFIG_KEYS = {
	projectPrefix: "string",
	services: "shape",
	apps: "shape",
	env: "function",
	hooks: "shape",
	migrations: "shape",
	seed: "shape",
	prisma: "shape",
	options: "shape",
	secrets: "shape",
	unsetEnv: "shape",
	docker: "shape",
	setupChecks: "shape",
	preflight: "shape",
	generatedFiles: "shape",
	integrations: "shape",
	tasks: "shape",
	typecheck: "shape",
	check: "shape",
	predeploy: "shape",
	profiles: "shape",
} as const satisfies Record<keyof DevConfig, FieldCheck>;

export const APP_KEYS = {
	kind: "shape",
	port: "shape",
	expose: "boolean",
	exposeProtocol: "shape",
	devCommand: "shape",
	prodCommand: "string",
	buildCommand: "string",
	cwd: "string",
	healthEndpoint: "shape",
	healthTimeout: "duration",
	extraPorts: "shape",
	stopGraceMs: "duration",
	requiredServices: "shape",
	requiredApps: "shape",
	startAfter: "shape",
	captures: "shape",
	restartOn: "shape",
	readyWhen: "shape",
	watch: "shape",
	prebuild: "string",
	exclusive: "string",
	entryPath: "shape",
	staticEnv: "shape",
	secrets: "shape",
	interactive: "boolean",
	essential: "boolean",
	actions: "shape",
	needsPublicUrls: "boolean",
	envVars: "function",
} as const satisfies Record<
	keyof AppOptions | keyof Extract<AppConfig, { kind: "worker" }>,
	FieldCheck
>;

export const SERVICE_KEYS = {
	kind: "shape",
	rerun: "shape",
	port: "shape",
	expose: "boolean",
	exposeProtocol: "shape",
	secondaryPort: "shape",
	bind: "string",
	healthCheck: "shape",
	healthTimeout: "duration",
	urlTemplate: "function",
	serviceName: "string",
	database: "string",
	user: "string",
	password: "string",
	env: "shape",
	staticEnv: "shape",
	afterPreparation: "boolean",
	docker: "shape",
	external: "shape",
} as const satisfies Record<
	keyof ServiceConfigBase | keyof Extract<ServiceConfig, { kind: "job" }>,
	FieldCheck
>;

export const OPTIONS_KEYS = {
	worktreeIsolation: "boolean",
	autoShutdown: "shape",
	verbose: "boolean",
	onAppFailure: "shape",
	primaryApp: "string",
	hosts: "shape",
	envFile: "shape",
	envFiles: "shape",
	checkoutFiles: "shape",
} as const satisfies Record<keyof DevOptions, FieldCheck>;

export const HOSTS_KEYS = {
	tld: "string",
	services: "shape",
} as const satisfies Record<keyof HostsOptions, FieldCheck>;

export const ENV_FILE_KEYS = {
	path: "string",
	createFrom: "string",
	values: "function",
} as const satisfies Record<keyof EnvFileOptions, FieldCheck>;

export const DOCKER_KEYS = {
	generatedFile: "string",
	writeStrategy: "string",
	volumes: "shape",
	autoStart: "boolean",
	runtime: "string",
	binary: "string",
	startCommand: "string",
} as const satisfies Record<keyof DockerComposeGenerationOptions, FieldCheck>;

export const PRISMA_KEYS = {
	cwd: "string",
	migrations: "string",
	schema: "string",
	service: "string",
	urlEnvVar: "shape",
	generate: "string",
	generateCheck: "shape",
} as const satisfies Record<keyof PrismaConfig, FieldCheck>;

export const SEED_KEYS = {
	requiredServices: "shape",
	beforeApps: "boolean",
	command: "string",
	cwd: "string",
	secrets: "shape",
	check: "function",
	forceExit: "boolean",
} as const satisfies Record<
	keyof SeedConfig<Record<string, ServiceConfig>, Record<string, AppConfig>>,
	FieldCheck
>;

export const SECRETS_KEYS = {
	projectId: "string",
	organizationId: "string",
	environment: "string",
	siteUrl: "string",
	path: "string",
	only: "shape",
	exclude: "shape",
	required: "shape",
} as const satisfies Record<keyof SecretsScopeConfig, FieldCheck>;

export const CAPTURE_KEYS = {
	pattern: "shape",
	as: "shape",
	label: "string",
	env: "shape",
	secret: "boolean",
} as const satisfies Record<keyof CaptureConfig, FieldCheck>;

export const WATCH_KEYS = {
	paths: "shape",
	ignore: "shape",
	debounceMs: "shape",
} as const satisfies Record<keyof AppWatchConfig, FieldCheck>;

export const TASK_KEYS = {
	command: "shape",
	description: "string",
	app: "string",
	cwd: "string",
	requiredServices: "shape",
} as const satisfies Record<keyof TaskConfig, FieldCheck>;

export const PROFILE_KEYS = {
	apps: "shape",
	description: "string",
} as const satisfies Record<keyof ProfileConfig, FieldCheck>;

/**
 * Keys a section used to take, with what replaces each, so the error for an
 * old config says what to write instead.
 */
export const RENAMED_KEYS: Readonly<Record<string, Record<string, string>>> = {
	config: {
		checks: "setupChecks",
		envVars: "env",
	},
	apps: {
		env: "staticEnv or envVars",
		expo: "integrations: [expo()]",
	},
	options: {
		frontendApp: "options.primaryApp",
		expoApiApp: "ports and urls (buncargo env --get)",
	},
	"options.hosts": {
		primaryApp: "options.primaryApp",
	},
};

/** The keys of a table whose values `fields()` checks with `typeof check`. */
export function keysChecked<TTable extends Record<string, FieldCheck>>(
	table: TTable,
	check: Exclude<FieldCheck, "shape">,
): string[] {
	return Object.entries(table)
		.filter(([, value]) => value === check)
		.map(([key]) => key);
}

/**
 * An error per key of `value` that `table` does not list: the replacement
 * when the key was renamed, else the keys the section takes.
 */
export function unknownKeyErrors(
	value: Record<string, unknown>,
	path: string,
	table: Record<string, FieldCheck> | readonly string[],
	renamed: Readonly<Record<string, string>> = {},
): string[] {
	const known = Array.isArray(table) ? table : Object.keys(table);
	const prefix = path === "config" ? "" : `${path}.`;
	return Object.keys(value)
		.filter((key) => !known.includes(key))
		.map((key) => {
			const replacement = renamed[key];
			return replacement
				? `${prefix}${key} was renamed: use ${replacement}`
				: `${prefix}${key} is not an option (${known.join(", ")})`;
		});
}
