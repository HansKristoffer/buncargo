import { getErrorMessage } from "hanzio";
import { defineCommand, runCommand } from "../cli/command-spec";
import * as log from "../cli/log";
import { findMonorepoRoot } from "../core/ports";
import { findRunsByRoot, type RunEntry } from "../core/run-registry";
import { openExpoSimulator } from "./simulator";

/**
 * `buncargo expo sim [<app>]` — this checkout's Expo app, in its own iOS simulator.
 *
 * Like `stop`, everything comes from the run registry: the Metro port, the
 * deep-link scheme and the source simulator were resolved when the run was
 * published, so this loads no config and is what the menu bar's phone button
 * runs. Each checkout gets a simulator device named after it, cloned from the
 * one the user already works in, so two worktrees show side by side.
 */

/** 0 opened · 1 failed · 2 nothing to open. */
const SIM_EXIT = { ok: 0, failed: 1, notFound: 2 } as const;

const simCommand = defineCommand({
	spec: {
		name: "expo sim",
		summary: "Boot this checkout's own iOS simulator and open the Expo app",
		flags: {
			root: {
				kind: "string",
				value: "<path>",
				description: "Checkout whose run to open (default: this one)",
			},
			run: {
				kind: "string",
				value: "<session>",
				description: "One run session from buncargo runs",
			},
		},
		args: [
			{
				name: "<app>",
				description: "The Expo app to open (default: the run's only one)",
			},
		],
		examples: [
			{
				command: "bunx buncargo expo sim",
				description: "Boot this checkout's simulator and open the app",
			},
		],
	},
	exits: {
		[SIM_EXIT.ok]: "opened",
		[SIM_EXIT.failed]: "failed, or bad arguments",
		[SIM_EXIT.notFound]: "nothing to open",
	},
	run: ({ values, positionals: [name] }) =>
		openSimulator(values.root ?? findMonorepoRoot(), values.run, name),
});

export function handleSim(args: string[] = []): Promise<number> {
	return runCommand(simCommand, args);
}

async function openSimulator(
	root: string,
	session: string | undefined,
	name: string | undefined,
): Promise<number> {
	const runs = (await findRunsByRoot(root)).filter(
		(run) => !session || run.sessionId === session,
	);
	const candidates = runs.flatMap((run) =>
		run.apps
			.filter((app) => app.expo && (!name || app.name === name))
			.map((app) => ({ run, app })),
	);
	if (candidates.length === 0) {
		if (runs.length === 0) {
			log.error(`No active buncargo run for ${root}.`);
			log.hint("Start one with `buncargo dev`, then `buncargo expo sim`.");
		} else if (name) {
			log.error(`"${name}" is not an Expo app of this run.`);
			log.hint(
				`Add it to \`expo({ apps: [...] })\` in dev.config.ts if it should be.`,
			);
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
	if (app.port === undefined) {
		log.error(`${app.name} has no listening port for Metro.`);
		return SIM_EXIT.failed;
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
		log.error(getErrorMessage(error));
		return SIM_EXIT.failed;
	}
}

function checkoutLabel(run: RunEntry): string {
	return `${run.projectPrefix}/${run.worktree ?? "main"}`;
}
