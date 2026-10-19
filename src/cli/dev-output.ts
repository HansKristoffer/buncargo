import { environmentOpenUrl } from "../core/app-url";
import { AppLogs } from "../core/process/app-logs";
import { printStream, RunOutput } from "../core/process/run-output";
import { isInteractive } from "../core/prompt";
import { prefixWidth } from "../core/style";
import type { AppConfig } from "../types";
import * as log from "./log";
import { watchRestartRequests, watchSendRequests } from "./restart-requests";
import { RunTui, type TuiAction } from "./tui/run-tui";

/** What `runDevFlow` needs of the environment to show a run's output. */
export interface DevOutputSource {
	root: string;
	sessionId: string;
	urls: object;
	loopbackUrls: object;
	publicUrls: object;
	hosts?: { active: boolean } | null;
	apps?: object;
}

/**
 * Where a dev run's app output goes. The TUI when there is a terminal to draw
 * it in and `--no-tui` was not passed; stream mode (prefixed lines) otherwise. Never both:
 * two writers on one screen is the garbling the TUI exists to end. Both write
 * the log files and answer `buncargo restart`.
 */
export function openDevOutput(
	env: DevOutputSource,
	apps: Record<string, AppConfig>,
	options: { tui: "auto" | "on" | "off" },
): {
	output: RunOutput;
	tui: boolean;
	start(): void;
	stop(): Promise<void>;
} {
	let logs: AppLogs | undefined;
	try {
		logs = new AppLogs(env.root, env.sessionId);
	} catch (error) {
		log.warn(`App output is not logged to files: ${String(error)}`);
	}
	const output = new RunOutput(logs);
	const names = Object.keys(apps);
	const terminal = isInteractive();
	if (options.tui === "on" && !terminal)
		log.warn("--tui needs a terminal; printing prefixed lines instead.");

	const actions = appActions(apps);
	const tui =
		options.tui !== "off" && terminal && names.length > 0
			? new RunTui({
					output,
					apps: names,
					urlFor: (app) => environmentOpenUrl(env, app),
					actions,
					logPath: (app) => (app ? logs?.file(app) : logs?.dir),
					quit: () => process.kill(process.pid, "SIGINT"),
				})
			: undefined;
	const stopPrinting = tui
		? undefined
		: printStream(output, { width: prefixWidth(names) });
	// Stream mode has no footer: say once where each declared action leads.
	const hinted = new Set<TuiAction>();
	const stopHints = tui
		? undefined
		: output.subscribe({
				capture: (app, captured) => {
					for (const action of actions)
						if (
							action.app === app &&
							action.open === captured.name &&
							!hinted.has(action)
						) {
							hinted.add(action);
							log.hint(
								`${app}: ${action.label} → buncargo open ${app} ${action.open}`,
							);
						}
				},
			});
	const stopStream = () => {
		stopPrinting?.();
		stopHints?.();
	};
	const stopRestarts = watchRestartRequests(env.root, env.sessionId, (app) => {
		void output.controls?.restart(app).catch(() => {});
	});
	// Keys for an app under a pseudo-terminal: one in the TUI, or an
	// interactive app with no terminal to attach to.
	const stopSends = watchSendRequests(env.root, env.sessionId, (app, text) => {
		const refusal = sendRefusal(output, app);
		if (refusal !== undefined) {
			output.event(app, `buncargo send: ${refusal}`, "warn");
			return refusal;
		}
		output.screens.get(app)?.input(text);
		return undefined;
	});
	const stopWatching = () => {
		stopRestarts();
		stopSends();
	};

	return {
		output,
		/** The TUI shows run events; stream mode only writes them to the logs. */
		tui: tui !== undefined,
		start: () => tui?.start(),
		stop: async () => {
			tui?.stop();
			// Before the printer goes: what the apps left on screen is printed too.
			await output.close();
			stopStream();
			stopWatching();
		},
	};
}

/** Why `app` cannot take keys from `buncargo send`, or `undefined` when it can. */
export function sendRefusal(
	output: Pick<RunOutput, "screens" | "states">,
	app: string,
): string | undefined {
	if (!output.screens.has(app))
		return "it has no terminal of its own to type into; every app in the TUI has one, and outside it an app with interactive: true";
	const state = output.states.get(app)?.state;
	if (state === "stopped" || state === "failed")
		return `it is not running (${state}); start it again with \`buncargo restart ${app}\``;
	return undefined;
}

function appActions(apps: Record<string, AppConfig>): TuiAction[] {
	return Object.entries(apps).flatMap(([app, config]) =>
		(config.actions ?? []).map((action) => ({ app, ...action })),
	);
}
