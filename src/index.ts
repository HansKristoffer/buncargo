// ═══════════════════════════════════════════════════════════════════════════
// Main Exports
// ═══════════════════════════════════════════════════════════════════════════

// CLI runner
export { getFlagValue, hasFlag, runCli } from "./cli/run-cli";
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
	PostgresServiceOptions,
	RedisServiceOptions,
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
	AppConfig,
	BuiltInHealthCheck,
	// CLI
	CliOptions,
	// Computed types
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
	// Main config
	DevConfig,
	// Environment interface
	DevEnvironment,
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
	// Migrations & Seed
	MigrationConfig,
	OpenPublicTunnelsOptions,
	OpenPublicTunnelsResult,
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
	UrlBuilderContext,
	UrlBuilderFn,
} from "./types/index";

// ═══════════════════════════════════════════════════════════════════════════
// Core Utilities (for advanced use cases)
// ═══════════════════════════════════════════════════════════════════════════

export { getLocalIp, isPortAvailable, waitForServer } from "./core/network";
export {
	calculatePortOffset,
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
	killProcessesOnAppPorts,
	killProcessOnPort,
	killProcessOnPortAndWait,
} from "./core/process";
export {
	type PublicExposeTarget,
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "./core/tunnel";
export {
	getEnvVar,
	isCI,
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
	DOCKER_NOT_RUNNING_MESSAGE,
	isContainerRunning,
	isDockerRunning,
	MAX_ATTEMPTS,
	POLL_INTERVAL,
} from "./docker/index";
export {
	buildComposeModel,
	composeToYaml,
	DEFAULT_GENERATED_COMPOSE_FILE,
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "./docker-compose/index";
