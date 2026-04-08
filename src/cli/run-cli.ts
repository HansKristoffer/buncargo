import { spawn } from "node:child_process";
import { isPortInUse, killProcessesOnAppPorts } from "../core/process";
import {
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "../core/tunnel";
import { spawnWatchdog, startHeartbeat, stopHeartbeat } from "../core/watchdog";
import { resolveSelectedApps } from "../planning";
import type {
	AppConfig,
	CliOptions,
	DevEnvironment,
	DevEnvironmentTunnelLog,
	ServiceConfig,
} from "../types";
import {
	classifyCliApps,
	parseRequiredCommaSeparatedFlag,
} from "./app-selection";
import {
	loadReusableTunnelApps,
	removeTunnelRegistryEntries,
	type TunnelRegistryEntry,
	upsertTunnelRegistryEntries,
} from "./tunnel-registry";

// ═══════════════════════════════════════════════════════════════════════════
// CLI Runner
// ═══════════════════════════════════════════════════════════════════════════

/** Accepted CLI flags */
const ACCEPTED_FLAGS = [
	"--help",
	"--down",
	"--reset",
	"--migrate",
	"--seed",
	"--up-only",
	"--expose",
	"--apps",
] as const;

/**
 * Print help message and exit.
 */
function printHelp(): void {
	console.log(`
Usage: buncargo dev [options]

Options:
  --help      Show this help message
  --down      Stop all containers
  --reset     Stop containers and remove volumes (fresh start)
  --migrate   Run migrations and exit
  --seed      Run migrations and seeders, then exit
  --up-only   Start containers and run migrations, then exit (no dev servers)
  --expose    Expose configured targets via public quick tunnels
  --apps      Run selected apps plus requiredApps

Examples:
  bun dev              Start dev environment with all services
  bun dev --seed       Run migrations and seed the database
  bun dev --down       Stop all containers
  bun dev --reset      Stop containers and remove all data
  bun dev --apps=api,platform  Run only selected apps
  bun dev --expose     Expose all targets with expose: true
  bun dev --expose=api,web  Expose specific targets
`);
}

/**
 * Validate CLI arguments and return unknown flags.
 */
function getUnknownFlags(args: string[]): string[] {
	return args.filter(
		(arg) =>
			arg.startsWith("--") &&
			!ACCEPTED_FLAGS.includes(
				(arg.includes("=")
					? arg.split("=")[0]
					: arg) as (typeof ACCEPTED_FLAGS)[number],
			),
	);
}

function logSelectedAppsSummary(input: {
	startNames: string[];
	reusedNames: string[];
	inferredReuseNames: string[];
}): void {
	const { startNames, reusedNames, inferredReuseNames } = input;

	console.log("");
	if (startNames.length > 0) {
		console.log(`🔧 Starting: ${startNames.join(", ")}`);
	}
	if (reusedNames.length > 0) {
		console.log(`♻️  Reusing: ${reusedNames.join(", ")}`);
	}
	if (inferredReuseNames.length > 0) {
		console.log(
			`   ℹ Inferred reuse from busy port: ${inferredReuseNames.join(", ")}`,
		);
	}
	console.log("");
}

/**
 * Run the CLI for a dev environment.
 * Handles common flags like --down, --reset, --up-only, --migrate, --seed.
 *
 * @example
 * ```typescript
 * import { dev } from './dev.config'
 * import { runCli } from 'buncargo'
 *
 * await runCli(dev)
 * ```
 */
export async function runCli<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: CliOptions & {
		/** Substitute tunnel helpers (used by CLI integration tests). */
		cliTestTunnel?: {
			resolveExposeTargets: typeof resolveExposeTargets;
			startPublicTunnels: typeof startPublicTunnels;
			stopPublicTunnels: typeof stopPublicTunnels;
		};
	} = {},
): Promise<void> {
	const {
		args = process.argv.slice(2),
		watchdog = true,
		watchdogTimeout = 10,
		devServersCommand,
		cliTestTunnel,
	} = options;
	const tunnelApi = cliTestTunnel ?? {
		resolveExposeTargets,
		startPublicTunnels,
		stopPublicTunnels,
	};
	const appsRequested = hasFlag(args, "--apps");
	const appsValue = getFlagValue(args, "--apps");
	const exposeRequested = hasFlag(args, "--expose");
	const exposeValue = getFlagValue(args, "--expose");
	let tunnels: PublicTunnel[] = [];
	let ownedTunnelRegistryEntries: TunnelRegistryEntry[] = [];

	async function cleanupTunnels(): Promise<void> {
		env.clearPublicUrls();
		const tunnelsToStop = tunnels;
		const registryEntriesToRemove = ownedTunnelRegistryEntries.map((entry) => ({
			kind: entry.kind,
			name: entry.name,
			pid: entry.pid,
		}));
		tunnels = [];
		ownedTunnelRegistryEntries = [];
		try {
			if (tunnelsToStop.length > 0) {
				await tunnelApi.stopPublicTunnels(tunnelsToStop);
			}
		} finally {
			if (registryEntriesToRemove.length > 0) {
				await removeTunnelRegistryEntries(env.root, registryEntriesToRemove);
			}
		}
	}

	// Handle --help
	if (args.includes("--help")) {
		printHelp();
		process.exit(0);
	}

	// Validate flags
	const unknownFlags = getUnknownFlags(args);
	if (unknownFlags.length > 0) {
		console.error(
			`❌ Unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}`,
		);
		console.error("");
		printHelp();
		process.exit(1);
	}

	// Handle --down (no need to start anything)
	if (args.includes("--down")) {
		env.logInfo();
		await cleanupTunnels();
		await env.stop();
		process.exit(0);
	}

	// Handle --reset (no need to start anything)
	if (args.includes("--reset")) {
		env.logInfo();
		await cleanupTunnels();
		await env.stop({ removeVolumes: true });
		process.exit(0);
	}

	let selectedAppNames: string[] | undefined;
	const selectedAppsPlan = resolveSelectedApps(env.apps, undefined);
	let appsForDev: Record<string, AppConfig> = selectedAppsPlan.apps;
	if (appsRequested) {
		try {
			selectedAppNames = parseRequiredCommaSeparatedFlag("--apps", appsValue);
			appsForDev = resolveSelectedApps(env.apps, selectedAppNames).apps;
		} catch (error) {
			console.error(
				`❌ ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		}
	}
	if (appsRequested && Object.keys(appsForDev).length === 0) {
		console.error("❌ Flag --apps requires at least one valid app name.");
		process.exit(1);
	}

	// All other paths need containers + migrations
	// Skip automatic seeding when --seed flag is used (CLI handles it explicitly)
	const skipSeed = args.includes("--seed");
	try {
		await env.start({
			startServers: false,
			wait: true,
			skipSeed,
			skipEnvironmentLog: exposeRequested,
			onlyApps: selectedAppNames,
		});
	} catch (error) {
		console.error(
			`❌ ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	let classifiedApps:
		| Awaited<ReturnType<typeof classifyCliApps>>
		| {
				startApps: Record<string, AppConfig>;
				reusedApps: Record<string, AppConfig>;
				startNames: string[];
				reusedNames: string[];
				inferredReuseNames: string[];
		  };
	try {
		classifiedApps = appsRequested
			? await classifyCliApps(appsForDev, env.ports, {
					isPortBusy: isPortInUse,
					waitForServer: env.waitForServer.bind(env),
				})
			: {
					startApps: appsForDev,
					reusedApps: {} as Record<string, AppConfig>,
					startNames: Object.keys(appsForDev),
					reusedNames: [] as string[],
					inferredReuseNames: [] as string[],
				};
	} catch (error) {
		console.error(
			`❌ ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
	const startAppNames = new Set(Object.keys(classifiedApps.startApps));
	const reusedAppNames = new Set(Object.keys(classifiedApps.reusedApps));
	const selectedAppNamesSet = new Set(Object.keys(appsForDev));
	const combinedTunnelLogs: DevEnvironmentTunnelLog[] = [];
	const inheritedPublicUrls: Record<string, string> = {};

	if (exposeRequested) {
		const { targets, unknownNames, notEnabledNames } =
			tunnelApi.resolveExposeTargets(env, exposeValue);
		if (unknownNames.length > 0) {
			console.error(
				`❌ Unknown expose target${unknownNames.length > 1 ? "s" : ""}: ${unknownNames.join(", ")}`,
			);
			await cleanupTunnels();
			process.exit(1);
		}
		if (notEnabledNames.length > 0) {
			console.error(
				`❌ Target${notEnabledNames.length > 1 ? "s" : ""} missing expose: true: ${notEnabledNames.join(", ")}`,
			);
			console.error(
				"   Mark these in dev.config.ts with expose: true or remove them from --expose.",
			);
			await cleanupTunnels();
			process.exit(1);
		}
		const explicitExposeNames =
			exposeValue === undefined
				? undefined
				: exposeValue
						.split(",")
						.map((name) => name.trim())
						.filter(Boolean);
		if (appsRequested && explicitExposeNames) {
			const excludedAppTargets = explicitExposeNames.filter(
				(name) =>
					env.apps[name] !== undefined && !selectedAppNamesSet.has(name),
			);
			if (excludedAppTargets.length > 0) {
				console.error(
					`❌ Expose target${excludedAppTargets.length > 1 ? "s" : ""} not included in --apps: ${excludedAppTargets.join(", ")}`,
				);
				console.error(
					"   Add these apps to --apps or remove them from --expose.",
				);
				await cleanupTunnels();
				process.exit(1);
			}
		}
		const filteredTargets = appsRequested
			? targets.filter(
					(target) =>
						target.kind === "service" || selectedAppNamesSet.has(target.name),
				)
			: targets;
		const reusedExposeAppNames = filteredTargets
			.filter(
				(target) => target.kind === "app" && reusedAppNames.has(target.name),
			)
			.map((target) => target.name);
		if (reusedExposeAppNames.length > 0) {
			const reusedTunnelData = await loadReusableTunnelApps(env.root, {
				appNames: reusedExposeAppNames,
				ports: env.ports,
			});
			Object.assign(inheritedPublicUrls, reusedTunnelData.publicUrls);
			combinedTunnelLogs.push(...reusedTunnelData.tunnels);
			if (reusedTunnelData.tunnels.length > 0) {
				console.log(
					`ℹ Reusing public URL${reusedTunnelData.tunnels.length > 1 ? "s" : ""} for: ${reusedTunnelData.tunnels.map((tunnel) => tunnel.name).join(", ")}`,
				);
			}
			if (reusedTunnelData.missingAppNames.length > 0) {
				console.warn(
					`⚠️  No reusable public URL found for: ${reusedTunnelData.missingAppNames.join(", ")}`,
				);
			}
		}
		const startExposeTargets = filteredTargets.filter(
			(target) => target.kind === "service" || startAppNames.has(target.name),
		);
		if (startExposeTargets.length === 0 && combinedTunnelLogs.length === 0) {
			console.error(
				"❌ No expose targets selected. Add expose: true to services/apps or pass names with --expose=<name>.",
			);
			await cleanupTunnels();
			process.exit(1);
		}
		if (startExposeTargets.length > 0) {
			tunnels = await tunnelApi.startPublicTunnels(startExposeTargets);
			const ownedPublicUrls = Object.fromEntries(
				tunnels.map((tunnel) => [tunnel.name, tunnel.publicUrl]),
			);
			env.setPublicUrls({
				...inheritedPublicUrls,
				...ownedPublicUrls,
			} as typeof env.publicUrls);
			ownedTunnelRegistryEntries = tunnels
				.filter((tunnel) => tunnel.kind === "app")
				.map((tunnel) => ({
					kind: "app" as const,
					name: tunnel.name,
					publicUrl: tunnel.publicUrl,
					localUrl: tunnel.localUrl,
					port: env.ports[tunnel.name] ?? 0,
					pid: process.pid,
					updatedAt: new Date().toISOString(),
				}));
			if (ownedTunnelRegistryEntries.length > 0) {
				await upsertTunnelRegistryEntries(env.root, ownedTunnelRegistryEntries);
			}
			combinedTunnelLogs.push(...tunnels);
		} else {
			env.setPublicUrls(inheritedPublicUrls as typeof env.publicUrls);
		}
		env.logInfo("Dev Environment", combinedTunnelLogs);
	}

	// Handle --migrate (exit after migrations)
	if (args.includes("--migrate")) {
		console.log("");
		console.log("✅ Migrations applied successfully");
		await cleanupTunnels();
		process.exit(0);
	}

	// Handle --seed (run seeders, then exit)
	if (args.includes("--seed")) {
		console.log("🌱 Running seeders...");
		const result = await env.exec("bun run run:seeder", {
			throwOnError: false,
		});
		if (result.exitCode !== 0) {
			console.error("❌ Seeding failed");
			if (result.stderr) {
				console.error(result.stderr);
			}
			if (result.stdout) {
				console.error(result.stdout);
			}
			await cleanupTunnels();
			process.exit(1);
		}
		console.log("");
		console.log("✅ Seeding complete");
		await cleanupTunnels();
		process.exit(0);
	}

	// Handle --up-only (exit after containers ready)
	if (args.includes("--up-only")) {
		console.log("");
		console.log("✅ Containers started. Environment ready.");
		console.log("");
		await cleanupTunnels();
		process.exit(0);
	}

	if (appsRequested) {
		logSelectedAppsSummary(classifiedApps);
	}

	if (appsRequested && classifiedApps.startNames.length === 0) {
		console.log("✅ Selected apps are already running. Nothing to start.");
		await cleanupTunnels();
		return;
	}

	// Build command: use provided command or auto-build from apps config
	const command =
		devServersCommand ?? buildDevServersCommand(classifiedApps.startApps);

	if (!command) {
		console.log("✅ Containers ready. No apps configured.");
		// Keep process alive if no apps
		await new Promise(() => {});
		await cleanupTunnels();
		return;
	}

	// Start watchdog and heartbeat for interactive mode
	if (watchdog) {
		await spawnWatchdog(env.projectName, env.root, {
			timeoutMinutes: watchdogTimeout,
			verbose: true,
			composeFile: env.composeFile,
		});
		startHeartbeat(env.projectName);
	}

	// Kill any existing processes on app ports before starting
	await killProcessesOnAppPorts(classifiedApps.startApps, env.ports);

	// Start dev servers interactively
	console.log("");
	console.log("🔧 Starting dev servers...");
	console.log("");

	await runCommand(command, env.root, env.buildEnvVars(), {
		onSignal: async () => {
			await cleanupTunnels();
			stopHeartbeat();
		},
	});

	// Clean up heartbeat on exit
	stopHeartbeat();
	await cleanupTunnels();
}

// ═══════════════════════════════════════════════════════════════════════════
// Command Building
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a concurrently command from the apps config.
 */
function buildDevServersCommand(
	apps: Record<string, AppConfig>,
): string | null {
	const appEntries = Object.entries(apps);
	if (appEntries.length === 0) return null;

	// Build commands for each app
	const commands: string[] = [];
	const names: string[] = [];
	const colors = ["blue", "green", "yellow", "magenta", "cyan", "red"];

	for (const [name, config] of appEntries) {
		names.push(name);
		const cwdPart = config.cwd ? `--cwd ${config.cwd}` : "";
		commands.push(
			`"bun run ${cwdPart} ${config.devCommand}"`.replace(/\s+/g, " ").trim(),
		);
	}

	// Use concurrently to run all apps
	const namesArg = `-n ${names.join(",")}`;
	const colorsArg = `-c ${colors.slice(0, names.length).join(",")}`;
	const commandsArg = commands.join(" ");

	return `bun concurrently ${namesArg} ${colorsArg} ${commandsArg}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Interactive Command Runner
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run a command interactively (inherits stdio).
 */
function runCommand(
	command: string,
	cwd: string,
	envVars: Record<string, string>,
	options: {
		onSignal?: () => void | Promise<void>;
	} = {},
): Promise<void> {
	const { onSignal } = options;
	return new Promise((resolve, reject) => {
		const proc = spawn(command, [], {
			cwd,
			env: { ...process.env, ...envVars },
			stdio: "inherit",
			shell: true,
		});

		proc.on("close", (code) => {
			if (code === 0 || code === null) {
				resolve();
			} else {
				reject(new Error(`Command exited with code ${code}`));
			}
		});

		proc.on("error", reject);

		// Handle SIGINT/SIGTERM
		const cleanup = () => {
			if (onSignal) {
				void onSignal();
			}
			proc.kill("SIGTERM");
		};

		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a CLI flag is present (including `--flag=value` form).
 */
export function hasFlag(args: string[], flag: string): boolean {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Get a flag value (e.g., --timeout=10 or --timeout 10).
 */
export function getFlagValue(args: string[], flag: string): string | undefined {
	// Check --flag=value format
	const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
	if (prefixed) {
		return prefixed.split("=")[1];
	}

	// Check --flag value format
	const index = args.indexOf(flag);
	if (index !== -1 && index + 1 < args.length) {
		const nextArg = args[index + 1];
		if (nextArg !== undefined && !nextArg.startsWith("-")) {
			return nextArg;
		}
	}

	return undefined;
}
