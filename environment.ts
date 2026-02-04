import pc from "picocolors";
import { assertValidConfig } from "./config";
import {
	areContainersRunning,
	startContainers,
	stopContainers,
	waitForAllServices,
} from "./core/docker";
import { getLocalIp, waitForDevServers, waitForServer } from "./core/network";
import {
	calculatePortOffset,
	computePorts,
	computeUrls,
	findMonorepoRoot,
	getProjectName,
	isWorktree,
} from "./core/ports";
import {
	buildApps,
	execAsync,
	startDevServers,
	stopProcess as stopProcessFn,
} from "./core/process";
import { isCI as isCIEnv, logExpoApiUrl, logFrontendPort } from "./core/utils";
import {
	spawnWatchdog as spawnWatchdogFn,
	startHeartbeat as startHeartbeatFn,
	stopHeartbeat as stopHeartbeatFn,
	stopWatchdog as stopWatchdogFn,
} from "./core/watchdog";
import { createPrismaRunner } from "./prisma";
import type {
	AppConfig,
	ComputedPorts,
	ComputedUrls,
	DevConfig,
	DevEnvironment,
	DevServerPids,
	ExecOptions,
	HookContext,
	PrismaRunner,
	ServiceConfig,
	StartOptions,
	StopOptions,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Console Output Formatting (Vite-inspired)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a URL with colored port number (Vite-style).
 */
function formatUrl(url: string): string {
	return pc.cyan(
		url.replace(/:(\d+)(\/?)/, (_, port, slash) => `:${pc.bold(port)}${slash}`),
	);
}

/**
 * Format a label with arrow prefix (Vite-style).
 */
function formatLabel(label: string, value: string, arrow = "➜"): string {
	return `  ${pc.green(arrow)}  ${pc.bold(label.padEnd(10))} ${value}`;
}

/**
 * Format a dim label (for secondary info).
 */
function formatDimLabel(label: string, value: string): string {
	return `  ${pc.dim("•")}  ${pc.dim(label.padEnd(10))} ${pc.dim(value)}`;
}

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
	const worktree = isWorktree(root);
	const portOffset = calculatePortOffset(suffix, root);
	const projectName = getProjectName(config.projectPrefix, suffix, root);
	const localIp = getLocalIp();

	const services = config.services;
	const apps = (config.apps ?? {}) as TApps;

	// Compute ports and URLs
	const ports = computePorts(services, apps, portOffset) as ComputedPorts<
		TServices,
		TApps
	>;
	const urls = computeUrls(services, apps, ports, localIp) as ComputedUrls<
		TServices,
		TApps
	>;

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

		// Call user's envVars function if provided
		if (config.envVars) {
			const userEnv = config.envVars(ports, urls, {
				projectName,
				localIp,
				portOffset,
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
		} = startOptions;

		const envVars = buildEnvVars(productionBuild);

		// Log environment info
		if (verbose) {
			logInfo(productionBuild ? "Production Environment" : "Dev Environment");
		}

		// Start containers
		const serviceCount = Object.keys(services).length;
		const alreadyRunning = await areContainersRunning(
			projectName,
			serviceCount,
		);

		if (alreadyRunning) {
			if (verbose) console.log("✓ Containers already running");
		} else {
			startContainers(root, projectName, envVars, {
				verbose,
				wait,
				composeFile: config.options?.composeFile,
			});
		}

		// Wait for services to be healthy
		if (wait) {
			await waitForAllServices(services, ports, {
				verbose,
				projectName,
				root,
			});
		}

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

			const migrationResults = await Promise.all(
				allMigrations.map(async (migration) => {
					const result = await exec(migration.command, {
						cwd: migration.cwd,
						throwOnError: false,
					});
					return { name: migration.name, result };
				}),
			);

		// Check for failures
		for (const { name, result } of migrationResults) {
			if (result.exitCode !== 0) {
				console.error(`❌ Migration "${name}" failed`);
				if (result.stdout) {
					console.error(result.stdout);
				}
				if (result.stderr) {
					console.error(result.stderr);
				}
				throw new Error(`Migration "${name}" failed`);
			}
		}

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
				// Create checkTable helper function with typed service parameter
				const checkTable = async (
					tableName: string,
					service?: keyof TServices,
				): Promise<boolean> => {
					const serviceName = (service ?? "postgres") as string;
					const serviceUrl = (urls as Record<string, string>)[serviceName];
					if (!serviceUrl) {
						console.warn(`⚠️ Service "${serviceName}" not found for checkTable`);
						return true; // Default to seeding if service not found
					}
				const checkResult = await exec(
					`psql "${serviceUrl}" -tAc 'SELECT COUNT(*) FROM "${tableName}" LIMIT 1'`,
					{ throwOnError: false },
				);
				const count = checkResult.stdout.trim();
				const shouldSeed = checkResult.exitCode !== 0 || count === "0" || count === "";
				if (!shouldSeed) {
					console.log(`  📊 Table "${tableName}" has ${count} rows`);
				}
				return shouldSeed;
				};

				// Build seed check context with helpers
				const seedCheckContext = {
					...getHookContext(),
					checkTable,
				};

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
		if (shouldStartServers && Object.keys(apps).length > 0) {
			// Run beforeServers hook
			if (config.hooks?.beforeServers) {
				await config.hooks.beforeServers(getHookContext());
			}

			// Build if production
			if (productionBuild) {
				buildApps(apps, root, envVars, { verbose });
			}

			// Start servers
			const pids = await startDevServers(apps, root, envVars, ports, {
				verbose,
				productionBuild,
				isCI,
			});

			// Wait for servers to be ready
			if (verbose) console.log("⏳ Waiting for servers to be ready...");
			await waitForDevServers(apps, ports, {
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
	}

	async function stop(stopOptions: StopOptions = {}): Promise<void> {
		const { verbose = true, removeVolumes = false } = stopOptions;

		// Run beforeStop hook
		if (config.hooks?.beforeStop) {
			await config.hooks.beforeStop(getHookContext());
		}

		stopContainers(root, projectName, {
			verbose,
			removeVolumes,
			composeFile: config.options?.composeFile,
		});
	}

	async function restart(): Promise<void> {
		await stop();
		await start({ startServers: false });
	}

	async function isRunning(): Promise<boolean> {
		const serviceCount = Object.keys(services).length;
		return areContainersRunning(projectName, serviceCount);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Server Management
	// ─────────────────────────────────────────────────────────────────────────

	async function startServersOnly(
		options: { productionBuild?: boolean; verbose?: boolean } = {},
	): Promise<DevServerPids> {
		const { productionBuild = false, verbose = true } = options;
		const envVars = buildEnvVars(productionBuild);
		const isCI = process.env.CI === "true";

		// Build if production
		if (productionBuild) {
			buildApps(apps, root, envVars, { verbose });
		}

		return startDevServers(apps, root, envVars, ports, {
			verbose,
			productionBuild,
			isCI,
		});
	}

	async function waitForServersReady(
		options: { timeout?: number; productionBuild?: boolean } = {},
	): Promise<void> {
		const { timeout = 60000, productionBuild = false } = options;
		await waitForDevServers(apps, ports, { timeout, productionBuild });
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	function logInfo(label = "Docker Dev"): void {
		const serviceNames = Object.keys(services);
		const appNames = Object.keys(apps);

		console.log("");
		console.log(`  ${pc.cyan(pc.bold(`🐳 ${label}`))}`);
		console.log(formatLabel("Project:", pc.white(projectName)));

		// Services section (Docker containers)
		if (serviceNames.length > 0) {
			console.log("");
			console.log(`  ${pc.dim("─── Services ───")}`);
			for (const name of serviceNames) {
				const port = (ports as Record<string, number>)[name];
				const url = `localhost:${port}`;
				console.log(formatLabel(`${name}:`, formatUrl(`http://${url}`)));
			}
		}

		// Apps section (Dev servers)
		if (appNames.length > 0) {
			console.log("");
			console.log(`  ${pc.dim("─── Applications ───")}`);
			for (const name of appNames) {
				const port = (ports as Record<string, number>)[name];
				const localUrl = `http://localhost:${port}`;
				const networkUrl = `http://${localIp}:${port}`;

				console.log(`  ${pc.green("➜")}  ${pc.bold(pc.cyan(name))}`);
				console.log(`       ${pc.dim("Local:")}   ${formatUrl(localUrl)}`);
				console.log(`       ${pc.dim("Network:")} ${formatUrl(networkUrl)}`);
			}
		}

		// Environment info
		console.log("");
		console.log(`  ${pc.dim("─── Environment ───")}`);
		console.log(formatDimLabel("Worktree:", worktree ? "yes" : "no"));
		console.log(
			formatDimLabel(
				"Port offset:",
				portOffset > 0 ? `+${portOffset}` : "none",
			),
		);
		if (suffix) {
			console.log(formatDimLabel("Suffix:", suffix));
		}
		console.log(formatDimLabel("Local IP:", localIp));
		console.log("");
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
			composeFile: config.options?.composeFile,
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
		apps,
		portOffset,
		isWorktree: worktree,
		localIp,
		root,

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
		exec,
		waitForServer: waitForServerUrl,
		logInfo,

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
