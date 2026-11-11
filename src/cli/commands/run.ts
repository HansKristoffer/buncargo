import { ensureSecretsSession } from "../../core/secrets/index";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import { loadDevEnv } from "../../loader";
import type { AnyDevEnvironment, TaskConfig } from "../../types";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { CliError } from "../errors";
import * as log from "../log";
import { commandSecretScopes } from "../secrets-scopes";
import { runForwardingSignals, withAppendedArgs } from "./exec";

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

async function runNamedTask(
	name: string | undefined,
	passthrough: readonly string[],
): Promise<number> {
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
	return runForwardingSignals(async (signal) => {
		const command = () =>
			env.exec(withAppendedArgs(task.command, extraArgs), {
				app: task.app,
				cwd: task.cwd,
				verbose: true,
				throwOnError: false,
				signal,
			});
		if (services.length === 0) return command();

		// Before the services: an expired Infisical session stops here, not
		// once they are up. The task's own fetch reuses this token.
		await ensureSecretsSession(commandSecretScopes(env, task.app), {
			signal,
		});
		// The CLI's idle hold, not the library's keep-forever default, so a
		// task that started a database leaves it on the same timer as a `dev`
		// run would.
		return env.withServices(
			services,
			{ claim: { defaultIdleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS }, signal },
			command,
		);
	});
}

export const runTaskCommand = defineCommand({
	spec: {
		name: "run",
		summary: "Run a task from dev.config.ts (lists them without a name)",
		flags: {},
		args: [{ name: "<task>", description: "A key of tasks in dev.config.ts" }],
		passthrough: "Arguments appended to the task's command",
		examples: [
			{ command: "buncargo run", description: "List the configured tasks" },
			{ command: "buncargo run shop:seed", description: "Run one task" },
		],
	},
	exits: {
		...BASE_EXITS,
		1: "bad arguments or task; otherwise the task's own code",
	},
	run: ({ positionals: [name], passthrough }) =>
		runNamedTask(name, passthrough),
});
