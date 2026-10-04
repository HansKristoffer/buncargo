import { appEntryPath, preferredAppUrl } from "../core/app-url";
import { AppLogs } from "../core/process/app-logs";
import { printStream, RunOutput } from "../core/process/run-output";
import { prefixWidth } from "../core/style";
import type { AppConfig } from "../types";
import * as log from "./log";
import { watchRestartRequests } from "./restart-requests";
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
 * Where a dev run's app output goes. The TUI when asked for and there is a
 * terminal to draw it in; stream mode (prefixed lines) otherwise. Never both:
 * two writers on one screen is the garbling the TUI exists to end. Both write
 * the log files and answer `buncargo restart`.
 */
export function openDevOutput(
	env: DevOutputSource,
	apps: Record<string, AppConfig>,
	options: { tui: boolean },
): { output: RunOutput; start(): void; stop(): void } {
	let logs: AppLogs | undefined;
	try {
		logs = new AppLogs(env.root, env.sessionId);
	} catch (error) {
		log.warn(`App output is not logged to files: ${String(error)}`);
	}
	const output = new RunOutput(logs);
	const names = Object.keys(apps);
	const terminal = Boolean(process.stdout.isTTY && process.stdin.isTTY);
	if (options.tui && !terminal)
		log.warn("--tui needs a terminal; printing prefixed lines instead.");

	const actions = appActions(apps);
	const tui =
		options.tui && terminal && names.length > 0
			? new RunTui({
					output,
					apps: names,
					urlFor: (app) => appOpenUrl(env, app),
					actions,
					logPath: (app) => (app ? logs?.file(app) : logs?.dir),
					quit: () => process.kill(process.pid, "SIGINT"),
				})
			: undefined;
	if (tui) output.terminalSize = () => tui.paneSize();
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
	const stopWatching = watchRestartRequests(env.root, env.sessionId, (app) => {
		void output.controls?.restart(app).catch(() => {});
	});

	return {
		output,
		start: () => tui?.start(),
		stop: () => {
			tui?.stop();
			stopStream();
			stopWatching();
			output.close();
		},
	};
}

/** The URL `o` and `buncargo open <app>` use, from the live environment. */
export function appOpenUrl(
	env: DevOutputSource,
	app: string,
): string | undefined {
	const read = (urls: object) =>
		(urls as Record<string, string | undefined>)[app];
	return preferredAppUrl(
		{
			url: read(env.urls),
			loopbackUrl: read(env.loopbackUrls),
			publicUrl: read(env.publicUrls),
			entryPath: appEntryPath(read(env.apps ?? {})),
		},
		env.hosts?.active ?? false,
	);
}

function appActions(apps: Record<string, AppConfig>): TuiAction[] {
	return Object.entries(apps).flatMap(([app, config]) =>
		(config.actions ?? []).map((action) => ({ app, ...action })),
	);
}
