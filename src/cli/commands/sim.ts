import { openExpoSimulator } from "../../core/expo";
import { findMonorepoRoot } from "../../core/ports";
import { findRunsByRoot, type RunEntry } from "../../core/run-registry";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "../command-spec";
import * as log from "../log";

/**
 * `buncargo sim [<app>]` — this checkout's Expo app, in its own iOS simulator.
 *
 * Like `stop`, everything comes from the run registry: the Metro port, the
 * deep-link scheme and the source simulator were resolved when the run was
 * published, so this loads no config and is what the menu bar's phone button
 * runs. Each checkout gets a simulator device named after it, cloned from the
 * one the user already works in, so two worktrees show side by side.
 */

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	root: {
		name: "--root",
		kind: "string",
		valueHint: "=<path>",
		description: "Checkout whose run to open (default: this one)",
	},
	run: {
		name: "--run",
		kind: "string",
		valueHint: "=<session>",
		description: "One run session from buncargo runs",
	},
} as const satisfies Record<string, FlagSpec>;

const SIM_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo sim [<app>] [options]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "<app>",
			description: "The Expo app to open (default: the run's only one)",
		},
	],
	examples: [
		{
			command: "bunx buncargo sim",
			description: "Boot this checkout's simulator and open the app",
		},
	],
};

/** 0 opened · 1 failed · 2 nothing to open. */
export const SIM_EXIT = { ok: 0, failed: 1, notFound: 2 } as const;

export async function handleSim(args: string[] = []): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(SIM_COMMAND_SPEC));
		return SIM_EXIT.ok;
	}
	const unknown = findUnknownFlags(SIM_COMMAND_SPEC, args);
	if (unknown.length > 0) {
		log.error(`Unknown flag(s): ${unknown.join(", ")}`);
		return SIM_EXIT.failed;
	}
	const errors: string[] = [];
	const root = readStringFlag(args, FLAGS.root, errors) ?? safeMonorepoRoot();
	const session = readStringFlag(args, FLAGS.run, errors);
	for (const problem of errors) log.error(problem);
	if (errors.length > 0) return SIM_EXIT.failed;
	const name = args.find(
		(arg, index) =>
			!arg.startsWith("--") &&
			args[index - 1] !== "--root" &&
			args[index - 1] !== "--run",
	);

	const runs = root
		? (await findRunsByRoot(root)).filter(
				(run) => !session || run.sessionId === session,
			)
		: [];
	const candidates = runs.flatMap((run) =>
		run.apps
			.filter((app) => app.expo && (!name || app.name === name))
			.map((app) => ({ run, app })),
	);
	if (candidates.length === 0) {
		if (runs.length === 0) {
			log.error(`No active buncargo run for ${root ?? "this directory"}.`);
			log.hint("Start one with `buncargo dev`, then `buncargo sim`.");
		} else if (name) {
			log.error(`"${name}" is not an Expo app of this run.`);
			log.hint(`Set \`expo: true\` on it in dev.config.ts if it should be.`);
		} else {
			log.error("This run has no Expo app.");
		}
		return SIM_EXIT.notFound;
	}
	if (candidates.length > 1 && !name) {
		log.error(
			`Several Expo apps are running: ${candidates.map((entry) => entry.app.name).join(", ")}. Name one.`,
		);
		return SIM_EXIT.notFound;
	}
	const [{ run, app }] = candidates as [(typeof candidates)[number]];
	if (app.status === "stopped" || app.status === "failed") {
		log.error(`${app.name} is ${app.status}; nothing is serving Metro.`);
		return SIM_EXIT.notFound;
	}

	try {
		const opened = await openExpoSimulator({
			label: checkoutLabel(run),
			port: app.port,
			expo: app.expo ?? {},
			log: log.info,
		});
		log.done(`Opened ${opened.url} on "${opened.device}"`);
		return SIM_EXIT.ok;
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		return SIM_EXIT.failed;
	}
}

function checkoutLabel(run: RunEntry): string {
	return `${run.projectPrefix}/${run.worktree ?? "main"}`;
}

function safeMonorepoRoot(): string | undefined {
	try {
		return findMonorepoRoot();
	} catch {
		return undefined;
	}
}
