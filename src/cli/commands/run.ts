import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import { loadDevEnv } from "../../loader";
import type { AnyDevEnvironment, TaskConfig } from "../../types";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readPositionals,
} from "../command-spec";
import { CliError } from "../errors";
import { splitCliArgs } from "../flags";
import * as log from "../log";
import { runForwardingSignals, withAppendedArgs } from "./exec";

export const RUN_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo run [<task>] [-- args...]",
	flags: [
		{ name: "--help", kind: "boolean", description: "Show this help message" },
	],
	notes: [
		{ command: "<task>", description: "A key of tasks in dev.config.ts" },
		{ command: "--", description: "Following arguments go to the command" },
	],
	examples: [
		{ command: "buncargo run", description: "List the configured tasks" },
		{ command: "buncargo run shop:seed", description: "Run one task" },
	],
};

/** One row per task, for `buncargo run` and `buncargo help`. */
export function formatTaskRows(
	tasks: Readonly<Record<string, TaskConfig>>,
): string[] {
	const entries = Object.entries(tasks);
	const width = Math.max(0, ...entries.map(([name]) => name.length));
	return entries.map(
		([name, task]) =>
			`  ${name.padEnd(width)}  ${task.description ?? task.command}`,
	);
}

export async function handleRun(args: string[]): Promise<number> {
	const { flags, passthrough } = splitCliArgs(args);
	if (flags.includes("--help")) {
		console.log(formatCommandHelp(RUN_COMMAND_SPEC));
		return 0;
	}

	const unknown = findUnknownFlags(RUN_COMMAND_SPEC, flags);
	const positionals = readPositionals(RUN_COMMAND_SPEC, flags);
	if (unknown.length > 0 || positionals.length > 1) {
		throw new CliError(
			unknown.length > 0
				? `Unknown flag: ${unknown.join(", ")}`
				: `Expected one task name, got: ${positionals.join(" ")}`,
			['Pass arguments for the task after "--".'],
		);
	}

	const [name] = positionals;
	const env = await loadDevEnv({ readOnly: true });
	const tasks = env.tasks ?? {};

	if (!name) {
		if (Object.keys(tasks).length === 0) {
			log.info("No tasks configured.");
			log.hint(
				"Add one to your dev config: tasks: { 'db:seed': { command: 'bun scripts/seed.ts' } }",
			);
			return 0;
		}
		log.line("Tasks:");
		for (const row of formatTaskRows(tasks)) log.line(row);
		return 0;
	}

	const selected = tasks[name];
	if (!selected) {
		const available = Object.keys(tasks);
		throw new CliError(
			`Unknown task "${name}".`,
			available.length > 0
				? [`Available tasks: ${available.join(", ")}`]
				: ["No tasks are configured in your dev config."],
		);
	}

	// Only a task that starts services allocates ports the way `dev` does;
	// everything else reads the persisted ones, like `exec`.
	return runTask(
		selected.requiredServices?.length ? await loadDevEnv() : env,
		selected,
		passthrough,
	);
}

async function runTask(
	env: AnyDevEnvironment,
	task: TaskConfig,
	extraArgs: readonly string[],
): Promise<number> {
	const services = task.requiredServices ?? [];
	try {
		return await runForwardingSignals(async (signal) => {
			if (services.length > 0) {
				// Prepared before claiming: the claim names the selection's
				// services. The CLI's idle hold, not the library's keep-forever
				// default, so a task that started a database leaves it on the
				// same timer as a `dev` run would.
				env.prepareStart?.(undefined, services);
				await env.claimRun({ defaultIdleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS });
				await env.start({
					onlyServices: services,
					startServers: false,
					prepare: "containers",
					skipEnvironmentLog: true,
					signal,
				});
			}

			return env.exec(withAppendedArgs(task.command, extraArgs), {
				app: task.app,
				cwd: task.cwd,
				verbose: true,
				throwOnError: false,
				signal,
			});
		});
	} finally {
		if (services.length > 0) await env.releaseRun();
	}
}
