import { applyIntegrations } from "../config/integrations";
import { findMonorepoRoot } from "../core/ports";
import { loadDevEnv } from "../loader";
import { findConfigFile } from "../loader/find-config-file";
import type {
	AnyDevEnvironment,
	BuncargoIntegration,
	IntegrationConfig,
} from "../types";
import { CliError } from "./errors";

/**
 * `buncargo <integration> <command>`.
 *
 * The configured instance wins, because its options (which toml, which app)
 * are what the command should act on. The built-in integrations also answer
 * without a config, so `buncargo expo sim` works from the menu bar, which runs
 * commands that only read the run registry.
 */

const BUILT_IN: Record<string, () => Promise<BuncargoIntegration>> = {
	expo: async () => (await import("../expo")).expo(),
	shopify: async () => (await import("../shopify")).shopify(),
};

/**
 * The config in reach with its integrations applied, or undefined.
 *
 * Imported rather than built into an environment: listing tasks and
 * integration commands needs names, not ports, and must not fail because a
 * port or Docker is unavailable. Anything that goes wrong reads as no config.
 */
export async function readAppliedConfig(): Promise<
	IntegrationConfig | undefined
> {
	const path = findConfigFile(process.cwd());
	if (!path) return undefined;
	try {
		const config = (await import(path)).default as
			| IntegrationConfig
			| undefined;
		return config ? applyIntegrations(config) : undefined;
	} catch {
		return undefined;
	}
}

async function resolveIntegration(
	name: string,
): Promise<BuncargoIntegration | undefined> {
	const configured = (await readAppliedConfig())?.integrations?.find(
		(integration) => integration.name === name,
	);
	return configured ?? (await BUILT_IN[name]?.());
}

/** Help lines for one integration's commands. */
export function integrationCommandRows(
	integration: BuncargoIntegration,
): { command: string; description: string }[] {
	return Object.entries(integration.commands ?? {}).map(([name, command]) => ({
		command: `${integration.name} ${command.usage ?? name}`,
		description: command.summary,
	}));
}

/** Returns the exit code, or `undefined` when no integration has this name. */
export async function runIntegrationCommand(
	name: string,
	args: string[],
): Promise<number | undefined> {
	const integration = await resolveIntegration(name);
	if (!integration) return undefined;

	const [commandName, ...rest] = args;
	const commands = integration.commands ?? {};
	const command = commandName ? commands[commandName] : undefined;
	if (!command) {
		const available = Object.keys(commands);
		throw new CliError(
			commandName
				? `Unknown ${name} command: ${commandName}`
				: `buncargo ${name} needs a command.`,
			available.length > 0
				? integrationCommandRows(integration).map(
						(row) => `buncargo ${row.command}  ${row.description}`,
					)
				: [`The ${name} integration has no commands.`],
		);
	}

	return command.run({
		args: rest,
		root: findMonorepoRoot(),
		loadEnv: async () => (await loadDevEnv()) as AnyDevEnvironment,
	});
}
