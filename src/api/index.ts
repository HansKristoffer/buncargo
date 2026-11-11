// `buncargo/api`: buncargo driven from code rather than from the CLI. The
// environment, the config loader, the CLI runner and the machine helpers a
// test harness or a script reaches for. A `dev.config.ts` imports `buncargo`.

export { runCli } from "../cli/run-cli";
export {
	assertValidConfig,
	resolveConfig,
	resolveServices,
	validateConfig,
} from "../config/index";
export {
	availableContainerRuntimes,
	CONTAINER_RUNTIME_SELECTIONS,
	type ContainerRuntimeAdapter,
	ContainerRuntimeUnavailableError,
	containerRuntimeDisplayName,
	containerRuntimeForEnv,
	ensureServicesRunning,
	listBuncargoContainers,
	type RuntimeCapabilities,
	type RuntimeContainer,
	resolveContainerRuntime,
	stopBuncargoContainers,
	waitForAllServices,
	waitForService,
} from "../container-runtime/index";
export { getLocalIp, waitForServer } from "../core/network";
export {
	type CheckoutProjectNames,
	type CheckoutProjectNamesOptions,
	checkoutProjectNames,
	computeDevIdentity,
	findMonorepoRoot,
	getProjectName,
	getWorktreeName,
	isWorktree,
} from "../core/ports";
export {
	getProcessOnPort,
	isPortInUse,
	isProcessAlive,
	killPortOwner,
} from "../core/process";
export { isCI } from "../core/runtime-flags";
export {
	type PublicExposeTarget,
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "../core/tunnel";
export { getEnvVar, logApiUrl, logFrontendPort, sleep } from "../core/utils";
export {
	ensureWatchdog,
	getWatchdogLogFile,
	getWatchdogPidFile,
} from "../core/watchdog";
export { assertDockerRunning, DockerUnavailableError } from "../docker/index";
export {
	buildComposeModel,
	composeToYaml,
	DEFAULT_GENERATED_COMPOSE_FILE,
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "../docker-compose/index";
export { createDevEnvironment } from "../environment/index";
export { clearDevEnvCache, getDevEnv, loadDevEnv } from "../loader/index";
export {
	runWorkspaceTypecheck,
	type TypecheckResult,
	type WorkspaceTypecheckOptions,
	type WorkspaceTypecheckResult,
} from "../typecheck/index";

export type {
	AnyDevEnvironment,
	CliOptions,
	DevEnvironment,
	DevEnvironmentFor,
	DevEnvironmentTunnelLog,
	DevServerPids,
	OpenPublicTunnelsOptions,
	OpenPublicTunnelsResult,
	PortOffsetProvenance,
	PrismaMigrateCheckOptions,
	PrismaNewMigrationOptions,
	PrismaNewMigrationResult,
	PrismaRunner,
	PrismaRunOptions,
	PublicTunnelHandle,
	ResolvedApp,
	ResolvedService,
	SeedOutcome,
	SeedRunOptions,
	ServicesStarted,
	StartOptions,
	StopOptions,
	WithServicesOptions,
} from "../types/index";
