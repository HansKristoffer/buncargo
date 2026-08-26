// ═══════════════════════════════════════════════════════════════════════════
// Main Exports
// ═══════════════════════════════════════════════════════════════════════════

// CLI runner
export { runCli } from "./cli/run-cli";
// Config factory
export {
	assertValidConfig,
	defineDevConfig,
	mergeConfigs,
	validateConfig,
} from "./config/index";
export type {
	ClickhouseServiceOptions,
	CustomServiceOptions,
	MailpitServiceOptions,
	PostgresServiceOptions,
	PresetServiceCredentialOptions,
	PresetServiceSecondaryPortOptions,
	PresetServiceSharedOptions,
	RedisServiceOptions,
	TypesenseServiceOptions,
} from "./docker-compose/services";
// Service helpers
export { service } from "./docker-compose/services";
// Environment factory
export { createDevEnvironment } from "./environment/index";
// Config loader (for programmatic access)
export { clearDevEnvCache, getDevEnv, loadDevEnv } from "./loader/index";
// Lint / Typecheck
export {
	runWorkspaceTypecheck,
	type TypecheckResult,
	type WorkspaceTypecheckOptions,
	type WorkspaceTypecheckResult,
} from "./typecheck/index";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type {
	AnyDevConfig,
	AnyDevEnvironment,
	AppConfig,
	BuiltInHealthCheck,
	// CLI
	CliOptions,
	// Computed types
	ComputedEnvVars,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
	// Main config
	DevConfig,
	DevConfigInput,
	DevConfigLike,
	// Environment interface
	DevEnvironment,
	DevEnvironmentFor,
	DevHooks,
	DevOptions,
	DevServerPids,
	DockerComposeGenerationOptions,
	DockerComposeHealthcheckRaw,
	DockerComposeNode,
	DockerComposeServiceRaw,
	DockerComposeVolumeRaw,
	DockerPresetName,
	DockerPresetServiceDefinition,
	DockerServiceDefinition,
	EnvVarsBuilder,
	ExecOptions,
	HealthCheckFn,
	HookContext,
	HostsOptions,
	HostsRuntime,
	// Migrations & Seed
	MigrationConfig,
	NamedHost,
	OpenPublicTunnelsOptions,
	OpenPublicTunnelsResult,
	PortOffsetProvenance,
	// Prisma
	PrismaConfig,
	PrismaRunner,
	PublicTunnelHandle,
	SeedCheckContext,
	SeedCheckHelpers,
	SeedConfig,
	// Service & App configs
	ServiceConfig,
	// Start/Stop options
	StartOptions,
	StopOptions,
	TypedAppDefinitions,
	UrlBuilderContext,
	UrlBuilderFn,
} from "./types/index";

// ═══════════════════════════════════════════════════════════════════════════
// Core Utilities (for advanced use cases)
// ═══════════════════════════════════════════════════════════════════════════

export { getLocalIp, isPortAvailable, waitForServer } from "./core/network";
export {
	computeDevIdentity,
	findMonorepoRoot,
	getProjectName,
	getWorktreeName,
	getWorktreeProjectSuffix,
	isWorktree,
} from "./core/ports";
export {
	getProcessOnPort,
	isPortInUse,
	isProcessAlive,
	killPortOwner,
} from "./core/process";
export { isCI } from "./core/runtime-flags";
export {
	type PublicExposeTarget,
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "./core/tunnel";
export {
	getEnvVar,
	logApiUrl,
	logExpoApiUrl,
	logFrontendPort,
	sleep,
} from "./core/utils";
export {
	getHeartbeatFile,
	getWatchdogPidFile,
	isWatchdogRunning,
	spawnWatchdog,
	startHeartbeat,
	stopHeartbeat,
	stopWatchdog,
} from "./core/watchdog";
export {
	areContainersRunning,
	assertDockerRunning,
	isContainerRunning,
	isDockerRunning,
} from "./docker/index";
export {
	buildComposeModel,
	composeToYaml,
	DEFAULT_GENERATED_COMPOSE_FILE,
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "./docker-compose/index";
