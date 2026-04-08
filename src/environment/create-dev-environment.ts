import { assertValidConfig } from "../config";
import { getLocalIp, waitForDevServers, waitForServer } from "../core/network";
import {
	computeDevIdentity,
	computePorts,
	computeUrls,
	findMonorepoRoot,
} from "../core/ports";
import {
	buildApps,
	execAsync,
	startDevServers,
	stopProcess as stopProcessFn,
} from "../core/process";
import {
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "../core/tunnel";
import { isCI as isCIEnv, logExpoApiUrl, logFrontendPort } from "../core/utils";
import {
	spawnWatchdog as spawnWatchdogFn,
	startHeartbeat as startHeartbeatFn,
	stopHeartbeat as stopHeartbeatFn,
	stopWatchdog as stopWatchdogFn,
} from "../core/watchdog";
import {
	areServicesRunning,
	ensureServicesRunning,
	stopContainers,
} from "../docker/runtime";
import {
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "../docker-compose";
import {
	assertOnlyAppNames,
	buildStartPlan,
	pickApps,
	resolveComposeServiceNames,
	resolveSelectedApps,
} from "../planning";
import { createPrismaRunner } from "../prisma";
import type {
	AppConfig,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
	DevConfig,
	DevEnvironment,
	DevEnvironmentTunnelLog,
	DevServerPids,
	ExecOptions,
	HookContext,
	OpenPublicTunnelsOptions,
	OpenPublicTunnelsResult,
	PrismaRunner,
	ServiceConfig,
	StartOptions,
	StopOptions,
} from "../types";
import { logEnvironmentInfo } from "./logging";
import { runMigrationsSequentially } from "./migrations";
import { createCheckTableHelper, createSeedCheckContext } from "./seeding";

// ═══════════════════════════════════════════════════════════════════════════
// Environment Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a dev environment from a configuration.
 *
 * @example
 * ```typescript
 * import { defineDevConfig, createDevEnvironment } from 'buncargo'
 *
 * const config = defineDevConfig({
 *   projectPrefix: 'myapp',
 *   services: { postgres: { port: 5432 } },
 *   apps: { api: { port: 3000, devCommand: 'bun run dev' } }
 * })
 *
 * export const dev = createDevEnvironment(config)
 *
 * // Usage
 * await dev.start()
 * ```
 */
export function createDevEnvironment<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	config: DevConfig<TServices, TApps>,
	options: { suffix?: string } = {},
): DevEnvironment<TServices, TApps> {
	// Validate config
	assertValidConfig(config);

	// Compute environment values
	const root = findMonorepoRoot();
	const suffix = options.suffix;
	const identity = computeDevIdentity({
		projectPrefix: config.projectPrefix,
		suffix,
		root,
		worktreeIsolation: config.options?.worktreeIsolation,
	});
	const { worktree, projectSuffix, portOffset, projectName } = identity;
	const localIp = getLocalIp();

	const services = config.services;
	const apps = (config.apps ?? {}) as TApps;
	const composeFile = getGeneratedComposePath(
		root,
		config.docker,
	).composeFileArg;

	function ensureComposeFile(): string {
		return writeGeneratedComposeFile(root, services, config.docker);
	}

	// Compute ports and URLs
	const ports = computePorts(services, apps, portOffset) as ComputedPorts<
		TServices,
		TApps
	>;
	const urls = computeUrls(services, apps, ports, localIp) as ComputedUrls<
		TServices,
		TApps
	>;
	const publicUrls: Record<string, string> = {};

	function setPublicUrls(urlsInput: Record<string, string>): void {
		for (const key of Object.keys(publicUrls)) {
			delete publicUrls[key];
		}
		for (const [key, value] of Object.entries(urlsInput)) {
			publicUrls[key] = value;
		}
	}

	function clearPublicUrls(): void {
		for (const key of Object.keys(publicUrls)) {
			delete publicUrls[key];
		}
	}

	// Build environment variables
	function buildEnvVars(production = false): Record<string, string> {
		const baseEnv: Record<string, string> = {
			COMPOSE_PROJECT_NAME: projectName,
			NODE_ENV: production ? "production" : "development",
		};

		// Add port environment variables for docker-compose
		for (const [name, port] of Object.entries(ports)) {
			const envName = `${name.toUpperCase()}_PORT`;
			baseEnv[envName] = String(port);
		}

		// Add URL environment variables
		for (const [name, url] of Object.entries(urls)) {
			const envName = `${name.toUpperCase()}_URL`;
			baseEnv[envName] = url;
		}

		// Add public URL environment variables when tunnels are active
		for (const [name, url] of Object.entries(publicUrls)) {
			const envName = `${name.toUpperCase()}_PUBLIC_URL`;
			baseEnv[envName] = url;
		}

		// Call user's envVars function if provided
		if (config.envVars) {
			const userEnv = config.envVars(ports, urls, {
				projectName,
				localIp,
				portOffset,
				publicUrls: publicUrls as ComputedPublicUrls<TServices, TApps>,
			});
			for (const [key, value] of Object.entries(userEnv)) {
				baseEnv[key] = String(value);
			}
		}

		return baseEnv;
	}

	// Memoized hook context (created once, reused)
	let hookContext: HookContext<TServices, TApps> | null = null;

	function getHookContext(): HookContext<TServices, TApps> {
		if (!hookContext) {
			hookContext = {
				projectName,
				ports,
				urls,
				publicUrls: publicUrls as ComputedPublicUrls<TServices, TApps>,
				root,
				isCI: isCIEnv(),
				portOffset,
				localIp,
				exec: async (cmd, opts) => {
					const envVars = buildEnvVars();
					return execAsync(cmd, root, envVars, opts);
				},
			};
		}
		return hookContext;
	}

	// Execute command helper
	function exec(cmd: string, options?: ExecOptions) {
		const envVars = buildEnvVars();
		return execAsync(cmd, root, envVars, options);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Container Management
	// ─────────────────────────────────────────────────────────────────────────

	async function start(
		startOptions: StartOptions = {},
	): Promise<DevServerPids | null> {
		const isCI = process.env.CI === "true";
		const {
			verbose = config.options?.verbose ?? true,
			wait = true,
			startServers: shouldStartServers = true,
			productionBuild = isCI,
			skipSeed = false,
			skipEnvironmentLog = false,
			onlyApps,
		} = startOptions;

		const startPlan = buildStartPlan(apps, services, onlyApps);
		const appsToStart = startPlan.apps;
		const targetServices = Object.fromEntries(
			startPlan.requiredServiceKeys.map((serviceKey) => [
				serviceKey,
				services[serviceKey],
			]),
		) as Record<string, ServiceConfig>;
		const targetPorts = Object.fromEntries(
			startPlan.requiredServiceKeys.map((serviceKey) => [
				serviceKey,
				(ports as Record<string, number>)[serviceKey],
			]),
		);
		let containersReady = false;

		const envVars = buildEnvVars(productionBuild);
		ensureComposeFile();

		// Log environment info
		if (verbose && !skipEnvironmentLog) {
			logInfo(productionBuild ? "Production Environment" : "Dev Environment");
		}

		// Start containers
		await ensureServicesRunning(
			root,
			projectName,
			envVars,
			targetServices,
			targetPorts,
			{
				verbose,
				wait,
				composeFile,
			},
		);
		containersReady = true;

		try {
			// Build migrations list (auto-add prisma if configured)
			const allMigrations = [
				// Auto-add prisma migration if prisma is configured
				...(config.prisma
					? [
							{
								name: "prisma",
								command: "bunx prisma migrate deploy",
								cwd: config.prisma.cwd ?? "packages/prisma",
							},
						]
					: []),
				// Add user-defined migrations
				...(config.migrations ?? []),
			];

			// Run migrations if any
			if (allMigrations.length > 0) {
				if (verbose) console.log("📦 Running migrations...");
				await runMigrationsSequentially(allMigrations, exec);

				if (verbose) console.log("✓ Migrations complete");
			}

			// Run afterContainersReady hook
			if (config.hooks?.afterContainersReady) {
				await config.hooks.afterContainersReady(getHookContext());
			}

			// Run seed if configured (skip if skipSeed is true, e.g., when CLI handles seeding)
			if (config.seed && !skipSeed) {
				let shouldSeed = true;

				// Check if seeding is needed using check function
				if (config.seed.check) {
					const checkTable = createCheckTableHelper<TServices, TApps>(
						urls as Record<string, string>,
						exec,
					);
					const seedCheckContext = createSeedCheckContext(
						getHookContext(),
						checkTable,
					);
					shouldSeed = await config.seed.check(seedCheckContext);
				}

				if (shouldSeed) {
					if (verbose) console.log("🌱 Running seeders...");
					const seedResult = await exec(config.seed.command, {
						cwd: config.seed.cwd,
						verbose,
						throwOnError: false,
					});
					if (seedResult.exitCode !== 0) {
						console.error("❌ Seeding failed");
						console.error(seedResult.stderr);
						// Don't throw - seeding failure shouldn't stop the environment
					} else {
						if (verbose) console.log("✓ Seeding complete");
					}
				} else {
					if (verbose)
						console.log("✓ Database already has data, skipping seeders");
				}
			}

			// Start servers if requested
			if (shouldStartServers && Object.keys(appsToStart).length > 0) {
				// Run beforeServers hook
				if (config.hooks?.beforeServers) {
					await config.hooks.beforeServers(getHookContext());
				}

				// Build if production
				if (productionBuild) {
					buildApps(appsToStart, root, envVars, { verbose });
				}

				// Start servers
				const pids = await startDevServers(appsToStart, root, envVars, ports, {
					verbose,
					productionBuild,
					isCI,
				});

				// Wait for servers to be ready
				if (verbose) console.log("⏳ Waiting for servers to be ready...");
				await waitForDevServers(appsToStart, ports, {
					timeout: isCI ? 120000 : 60000,
					verbose,
					productionBuild,
				});

				// Run afterServers hook
				if (config.hooks?.afterServers) {
					await config.hooks.afterServers(getHookContext());
				}

				if (verbose) console.log("✅ Environment ready\n");
				return pids;
			}

			if (verbose) console.log("✅ Containers ready\n");
			return null;
		} catch (error) {
			if (containersReady) {
				console.error(
					"ℹ Containers are still running. Use `bunx buncargo dev --down` to stop them.",
				);
			}
			throw error;
		}
	}

	async function stop(stopOptions: StopOptions = {}): Promise<void> {
		const { verbose = true, removeVolumes = false } = stopOptions;
		ensureComposeFile();

		// Run beforeStop hook
		if (config.hooks?.beforeStop) {
			await config.hooks.beforeStop(getHookContext());
		}

		stopContainers(root, projectName, {
			verbose,
			removeVolumes,
			composeFile,
		});
	}

	async function restart(): Promise<void> {
		await stop();
		await start({ startServers: false });
	}

	async function isRunning(): Promise<boolean> {
		return areServicesRunning(
			projectName,
			resolveComposeServiceNames(services, Object.keys(services)),
		);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Server Management
	// ─────────────────────────────────────────────────────────────────────────

	async function startServersOnly(
		options: {
			productionBuild?: boolean;
			verbose?: boolean;
			onlyApps?: string[];
		} = {},
	): Promise<DevServerPids> {
		const { productionBuild = false, verbose = true, onlyApps } = options;
		const selection = resolveSelectedApps(apps, onlyApps);
		const appsToStart = selection.apps;
		const envVars = buildEnvVars(productionBuild);
		const isCI = process.env.CI === "true";

		if (Object.keys(appsToStart).length === 0) {
			return {};
		}

		// Build if production
		if (productionBuild) {
			buildApps(appsToStart, root, envVars, { verbose });
		}

		const pids = await startDevServers(appsToStart, root, envVars, ports, {
			verbose,
			productionBuild,
			isCI,
		});

		if (verbose) console.log("⏳ Waiting for servers to be ready...");
		await waitForDevServers(appsToStart, ports, {
			timeout: isCI ? 120000 : 60000,
			verbose,
			productionBuild,
		});

		return pids;
	}

	async function waitForServersReady(
		options: {
			timeout?: number;
			productionBuild?: boolean;
			onlyApps?: string[];
		} = {},
	): Promise<void> {
		const { timeout = 60000, productionBuild = false, onlyApps } = options;
		const selection = resolveSelectedApps(apps, onlyApps);
		const appsToWait = selection.apps;
		await waitForDevServers(appsToWait, ports, { timeout, productionBuild });
	}

	async function openPublicTunnels(
		options: OpenPublicTunnelsOptions = {},
	): Promise<OpenPublicTunnelsResult<TServices, TApps>> {
		const { names, waitForHealthy } = options;
		const exposeList = names?.length ? names.join(",") : undefined;

		if (waitForHealthy?.length) {
			assertOnlyAppNames(Object.keys(apps), waitForHealthy);
			const appsWait = pickApps(apps, waitForHealthy);
			const isCI = process.env.CI === "true";
			await waitForDevServers(appsWait, ports, {
				timeout: isCI ? 120000 : 60000,
				verbose: config.options?.verbose ?? true,
				productionBuild: false,
			});
		}

		const { targets, unknownNames, notEnabledNames } = resolveExposeTargets(
			{
				services,
				apps,
				ports,
			} as DevEnvironment<TServices, TApps>,
			exposeList,
		);

		if (unknownNames.length > 0) {
			throw new Error(`Unknown expose target(s): ${unknownNames.join(", ")}`);
		}
		if (notEnabledNames.length > 0) {
			throw new Error(
				`Target(s) missing expose: true: ${notEnabledNames.join(", ")}`,
			);
		}
		if (targets.length === 0) {
			throw new Error(
				"No expose targets selected. Add expose: true to services/apps or pass names that have expose: true.",
			);
		}

		const tunnels = await startPublicTunnels(targets);
		setPublicUrls(
			Object.fromEntries(tunnels.map((t) => [t.name, t.publicUrl])),
		);

		let closed = false;
		async function close(): Promise<void> {
			if (closed) return;
			closed = true;
			await stopPublicTunnels(tunnels);
			clearPublicUrls();
		}

		return {
			publicUrls: { ...publicUrls } as ComputedPublicUrls<TServices, TApps>,
			tunnels,
			close,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	function logInfo(label = "Docker Dev", tunnels?: PublicTunnel[]): void {
		const tunnelRows: DevEnvironmentTunnelLog[] | undefined = tunnels?.map(
			({ kind, name, localUrl, publicUrl }) => ({
				kind,
				name,
				localUrl,
				publicUrl,
			}),
		);
		logEnvironmentInfo({
			label,
			projectName,
			services,
			apps,
			ports: ports as Record<string, number>,
			localIp,
			worktree,
			portOffset,
			projectSuffix,
			tunnels: tunnelRows,
		});
	}

	async function waitForServerUrl(
		url: string,
		timeout?: number,
	): Promise<void> {
		await waitForServer(url, { timeout });
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Watchdog / Heartbeat
	// ─────────────────────────────────────────────────────────────────────────

	function startHeartbeat(intervalMs?: number): void {
		startHeartbeatFn(projectName, intervalMs);
	}

	function stopHeartbeat(): void {
		stopHeartbeatFn();
	}

	async function spawnWatchdog(timeoutMinutes?: number): Promise<void> {
		await spawnWatchdogFn(projectName, root, {
			timeoutMinutes,
			verbose: true,
			composeFile,
		});
	}

	function stopWatchdog(): void {
		stopWatchdogFn(projectName);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Vibe Kanban Integration
	// ─────────────────────────────────────────────────────────────────────────

	function getExpoApiUrl(): string {
		const apiPort = (ports as Record<string, number>).api;
		const url = `http://${localIp}:${apiPort}`;
		logExpoApiUrl(url);
		return url;
	}

	function getFrontendPort(): number | undefined {
		const port = (ports as Record<string, number>).platform;
		logFrontendPort(port);
		return port;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Advanced
	// ─────────────────────────────────────────────────────────────────────────

	function withSuffix(newSuffix: string): DevEnvironment<TServices, TApps> {
		return createDevEnvironment(config, { suffix: newSuffix });
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Return Environment Object
	// ─────────────────────────────────────────────────────────────────────────

	// Build base environment
	const env: DevEnvironment<TServices, TApps> = {
		// Configuration access
		projectName,
		ports,
		urls,
		publicUrls: publicUrls as ComputedPublicUrls<TServices, TApps>,
		services,
		apps,
		portOffset,
		isWorktree: worktree,
		localIp,
		root,
		composeFile,

		// Container management
		start,
		stop,
		restart,
		isRunning,

		// Server management
		startServers: startServersOnly,
		stopProcess: stopProcessFn,
		waitForServers: waitForServersReady,

		// Utilities
		buildEnvVars,
		setPublicUrls: (urlsInput) => {
			setPublicUrls(urlsInput as Record<string, string>);
		},
		clearPublicUrls,
		ensureComposeFile,
		exec,
		waitForServer: waitForServerUrl,
		logInfo,
		openPublicTunnels,

		// Vibe Kanban Integration
		getExpoApiUrl,
		getFrontendPort,

		// Watchdog / Heartbeat
		startHeartbeat,
		stopHeartbeat,
		spawnWatchdog,
		stopWatchdog,

		// Prisma (created below if configured)
		prisma: undefined,

		// Advanced
		withSuffix,
	};

	// Create prisma runner if configured
	if (config.prisma) {
		(env as { prisma: PrismaRunner }).prisma = createPrismaRunner(
			env,
			config.prisma,
		);
	}

	return env;
}
