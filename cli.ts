import { spawn } from "node:child_process";
import { killProcessesOnAppPorts } from "./core/process";
import { spawnWatchdog, startHeartbeat, stopHeartbeat } from "./core/watchdog";
import type {
	AppConfig,
	CliOptions,
	DevEnvironment,
	ServiceConfig,
} from "./types";

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

Examples:
  bun dev              Start dev environment with all services
  bun dev --seed       Run migrations and seed the database
  bun dev --down       Stop all containers
  bun dev --reset      Stop containers and remove all data
`);
}

/**
 * Validate CLI arguments and return unknown flags.
 */
function getUnknownFlags(args: string[]): string[] {
	return args.filter(
		(arg) => arg.startsWith("--") && !ACCEPTED_FLAGS.includes(arg as typeof ACCEPTED_FLAGS[number]),
	);
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
	options: CliOptions = {},
): Promise<void> {
	const {
		args = process.argv.slice(2),
		watchdog = true,
		watchdogTimeout = 10,
		devServersCommand,
	} = options;

	// Handle --help
	if (args.includes("--help")) {
		printHelp();
		process.exit(0);
	}

	// Validate flags
	const unknownFlags = getUnknownFlags(args);
	if (unknownFlags.length > 0) {
		console.error(`❌ Unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}`);
		console.error("");
		printHelp();
		process.exit(1);
	}

	// Handle --down (no need to start anything)
	if (args.includes("--down")) {
		env.logInfo();
		await env.stop();
		process.exit(0);
	}

	// Handle --reset (no need to start anything)
	if (args.includes("--reset")) {
		env.logInfo();
		await env.stop({ removeVolumes: true });
		process.exit(0);
	}

	// All other paths need containers + migrations
	// Skip automatic seeding when --seed flag is used (CLI handles it explicitly)
	const skipSeed = args.includes("--seed");
	await env.start({ startServers: false, wait: true, skipSeed });

	// Handle --migrate (exit after migrations)
	if (args.includes("--migrate")) {
		console.log("");
		console.log("✅ Migrations applied successfully");
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
			process.exit(1);
		}
		console.log("");
		console.log("✅ Seeding complete");
		process.exit(0);
	}

	// Handle --up-only (exit after containers ready)
	if (args.includes("--up-only")) {
		console.log("");
		console.log("✅ Containers started. Environment ready.");
		console.log("");
		process.exit(0);
	}

	// Start watchdog and heartbeat for interactive mode
	if (watchdog) {
		await spawnWatchdog(env.projectName, env.root, {
			timeoutMinutes: watchdogTimeout,
			verbose: true,
		});
		startHeartbeat(env.projectName);
	}

	// Build command: use provided command or auto-build from apps config
	const command = devServersCommand ?? buildDevServersCommand(env.apps);

	if (!command) {
		console.log("✅ Containers ready. No apps configured.");
		// Keep process alive if no apps
		await new Promise(() => {});
		return;
	}

	// Kill any existing processes on app ports before starting
	await killProcessesOnAppPorts(env.apps, env.ports);

	// Start dev servers interactively
	console.log("");
	console.log("🔧 Starting dev servers...");
	console.log("");

	await runCommand(command, env.root, env.buildEnvVars());

	// Clean up heartbeat on exit
	stopHeartbeat();
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
): Promise<void> {
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
 * Check if a CLI flag is present.
 */
export function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
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
