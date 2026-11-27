import { getErrorMessage } from "hanzio";
import pc from "picocolors";
import { environmentOpenUrl } from "../core/app-url";
import { AppLogs } from "../core/process/app-logs";
import { printStream, RunOutput } from "../core/process/run-output";
import { isInteractive } from "../core/prompt";
import { colorizeName, prefixWidth } from "../core/style";
import type {
	LinkInspection,
	ResolvedApp,
	ResolvedEgressGuardConfig,
} from "../types";
import * as log from "./log";
import {
	type RestartReply,
	watchRestartRequests,
	watchSendRequests,
} from "./restart-requests";
import type { RunTui, TuiAction } from "./tui/run-tui";

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
export async function openDevOutput(
	env: DevOutputSource,
	apps: Record<string, ResolvedApp>,
	options: {
		tui: "auto" | "on" | "off";
		tasks?: readonly string[];
		/** Apps the run left out, which the TUI lists to start and `restart` starts. */
		leftOut?: readonly string[];
		/** Full configured apps map so late-started apps still receive declared `actions`. */
		allApps?: Readonly<Record<string, ResolvedApp>>;
		profile?: string;
		info?: (output: RunOutput) => readonly string[];
	},
): Promise<{
	output: RunOutput;
	start(): void;
	stop(): Promise<void>;
}> {
	let logs: AppLogs | undefined;
	try {
		logs = new AppLogs(env.root, env.sessionId);
	} catch (error) {
		log.warn(`App output is not logged to files: ${String(error)}`);
	}

	const names = Object.keys(apps);
	const taskNames = options.tasks ?? [];
	const leftOut = new Set(options.leftOut);
	// Keep left-out apps alongside active apps, above the `Tasks` divider.
	const panes = [...names, ...leftOut, ...taskNames];
	const terminal = isInteractive();
	if (options.tui === "on" && !terminal) {
		log.warn("--tui needs a terminal; printing prefixed lines instead.");
	}

	const actions = appActions(options.allApps ?? apps);
	const useTui = options.tui !== "off" && terminal && panes.length > 0;

	// In the TUI every app gets a terminal of its own, sized to its pane.
	// Load the TUI modules only when a terminal actually draws it, so detached,
	// CI and stream runs skip parsing them.
	const output = new RunOutput({ terminals: useTui ? "pty" : "pipe", logs });
	let tui: RunTui | undefined;
	const info = options.info;
	if (useTui) {
		const { RunTui: RunTuiClass } = await import("./tui/run-tui");
		tui = new RunTuiClass({
			output,
			apps: panes,
			taskNames: new Set(taskNames),
			leftOut,
			profile: options.profile,
			info: info ? () => info(output) : undefined,
			urlFor: (app) => environmentOpenUrl(env, app),
			actions,
			logPath: (app) => (app ? logs?.file(app) : logs?.dir),
			quit: () => process.kill(process.pid, "SIGINT"),
		});
	}

	// Once a late-started app leaves its initial `starting` phase (ready/stopped/failed),
	// graduate it out of `pendingLeftOut` so later `buncargo restart` calls restart it normally.
	const pendingLeftOut = new Set(options.leftOut);
	const stopLeftOutWatch =
		pendingLeftOut.size > 0
			? output.subscribe({
					state: (app, detail) => {
						if (detail.state !== "starting") pendingLeftOut.delete(app);
					},
				})
			: undefined;

	const stopPrinting = tui
		? undefined
		: printStream(output, { width: prefixWidth(panes) });

	// Stream mode has no footer: say once where each declared action leads.
	const hinted = new Set<TuiAction>();
	const stopHints = tui
		? undefined
		: output.subscribe({
				capture: (app, captured) => {
					for (const action of actions) {
						const isThisCapture =
							action.app === app && action.open === captured.name;
						if (!isThisCapture || hinted.has(action)) continue;

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

	// Left waiting until the spawner binds `controls`, rather than read and
	// dropped by a run still starting.
	const stopRestarts = watchRestartRequests(
		env.root,
		env.sessionId,
		(app) => restartReply(output, app, pendingLeftOut),
		() => output.controls !== undefined,
	);

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
		stopLeftOutWatch?.();
		stopRestarts();
		stopSends();
	};

	return {
		output,
		start: () => tui?.start(),
		stop: async () => {
			// Before either view goes: what the apps left on screen reaches it,
			// as it does the log files. Dispose virtual terminals after the TUI
			// releases its markers, even if `close()` rejects.
			try {
				await output.close();
			} finally {
				tui?.stop();
				output.dispose();
				stopStream();
				stopWatching();
			}
		},
	};
}

/**
 * What came of `buncargo restart <app>`, for the command waiting on it. An
 * app the run left out (`leftOut`) is started instead.
 */
export async function restartReply(
	output: Pick<RunOutput, "controls" | "states" | "startApp">,
	app: string,
	leftOut: ReadonlySet<string>,
): Promise<RestartReply> {
	// Taken on and not up yet: asking again is not a restart of it.
	if (leftOut.has(app) && output.states.get(app)?.state === "starting") {
		return { status: "started", apps: [] };
	}

	if (!output.states.has(app) && leftOut.has(app)) {
		// Not a refusal: asked again once the run's own apps are up, it starts.
		if (!output.startApp) {
			return {
				status: "failed",
				reason:
					"the run is still starting its own apps; ask again once they are up",
			};
		}
		try {
			return await output.startApp(app);
		} catch (error) {
			return { status: "failed", reason: getErrorMessage(error) };
		}
	}

	if (!output.states.has(app) || !output.controls) {
		return { status: "not-ours", reason: `this run started no app "${app}"` };
	}

	try {
		return (await output.controls.restart(app))
			? { status: "began" }
			: {
					status: "not-ours",
					reason:
						"its process is not this run's (reused from another terminal), or the run is ending",
				};
	} catch (error) {
		return { status: "failed", reason: getErrorMessage(error) };
	}
}

/** Why `app` cannot take keys from `buncargo send`, or `undefined` when it can. */
export function sendRefusal(
	output: Pick<RunOutput, "screens" | "states">,
	app: string,
): string | undefined {
	if (!output.screens.has(app)) {
		return "it has no terminal of its own to type into; every app in the TUI has one, and outside it an app with interactive: true";
	}

	const state = output.states.get(app)?.state;
	if (state === "stopped" || state === "failed")
		return `it is not running (${state}); start it again with \`buncargo restart ${app}\``;
	return undefined;
}

function appActions(apps: Readonly<Record<string, ResolvedApp>>): TuiAction[] {
	return Object.entries(apps).flatMap(([app, config]) =>
		(config.actions ?? []).map((action) => ({ app, ...action })),
	);
}

/** Live environment summary shown inside the TUI's `i` / `?` overlay. */
export function formatTuiInfoLines(input: {
	projectName: string;
	root: string;
	portOffset: number;
	profile?: string;
	hostsMode?: string;
	egressGuard?: ResolvedEgressGuardConfig;
	ports: Readonly<Record<string, number | undefined>>;
	urls: Readonly<Record<string, string | undefined>>;
	loopbackUrls: Readonly<Record<string, string | undefined>>;
	publicUrls: Readonly<Record<string, string | undefined>>;
	serviceKeys: readonly string[];
	appNames: readonly string[];
	reusedNames: ReadonlySet<string>;
	leftOutNames?: ReadonlySet<string>;
	taskNames: readonly string[];
	urlFor: (app: string) => string | undefined;
	output: RunOutput;
	links: readonly LinkInspection[];
}): string[] {
	const lines: string[] = [];
	const meta = [
		pc.bold(input.projectName),
		input.profile ? `profile: ${pc.cyan(input.profile)}` : undefined,
		`offset: +${input.portOffset}`,
		input.hostsMode ? `hosts: ${input.hostsMode}` : undefined,
		input.egressGuard?.enabled
			? `egress: ${input.egressGuard.mode}`
			: undefined,
	].filter((part): part is string => part !== undefined);

	lines.push(` ${meta.join(pc.dim(" · "))}`);
	lines.push(` ${pc.dim(input.root)}`);

	if (input.serviceKeys.length > 0) {
		lines.push("", pc.bold(" Services"));
		const width = Math.max(8, ...input.serviceKeys.map((k) => k.length));
		for (const key of input.serviceKeys) {
			const port = input.ports[key];
			const url = input.urls[key];
			const detail = url ?? (port !== undefined ? `:${port}` : "");
			lines.push(`  ${pc.green("●")} ${key.padEnd(width)}  ${pc.dim(detail)}`);
		}
	}

	if (input.appNames.length > 0) {
		lines.push("", pc.bold(" Apps"));
		const width = Math.max(8, ...input.appNames.map((n) => n.length));
		for (const name of input.appNames) {
			const state = input.output.states.get(name);
			const isOff = input.leftOutNames?.has(name) === true && !state;
			const status = input.reusedNames.has(name)
				? pc.cyan("reused")
				: isOff
					? "off"
					: (state?.detail ?? state?.state ?? "starting");
			const open = isOff ? undefined : input.urlFor(name);
			const loopback = isOff ? undefined : input.loopbackUrls[name];
			const extra =
				open && loopback && open !== loopback ? pc.dim(` (${loopback})`) : "";
			const addr = isOff
				? pc.dim("not started")
				: open
					? pc.cyan(open)
					: pc.dim("worker");
			const label = isOff
				? pc.dim(name.padEnd(width))
				: colorizeName(name.padEnd(width));
			lines.push(`  ${label}  ${addr}${extra}  ${pc.dim(`[${status}]`)}`);
		}
	}

	if (input.taskNames.length > 0) {
		lines.push("", pc.bold(" Reactive Tasks"));
		const width = Math.max(8, ...input.taskNames.map((n) => n.length));
		for (const name of input.taskNames) {
			const state = input.output.states.get(name);
			const status = state?.detail ?? state?.state ?? "idle";
			lines.push(`  ${colorizeName(name.padEnd(width))}  ${pc.dim(status)}`);
		}
	}

	const tunnels = Object.entries(input.publicUrls).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	);
	if (tunnels.length > 0) {
		lines.push("", pc.bold(" Public Tunnels"));
		const width = Math.max(8, ...tunnels.map(([n]) => n.length));
		for (const [name, url] of tunnels) {
			lines.push(`  ${colorizeName(name.padEnd(width))}  ${pc.cyan(url)}`);
		}
	}

	if (input.links.length > 0) {
		lines.push("", pc.bold(" Links"));
		const width = Math.max(8, ...input.links.map((l) => l.name.length));
		for (const item of input.links) {
			if (item.link) {
				const branch = item.link.branch ? ` (${item.link.branch})` : "";
				const target = `${item.link.projectName}${branch} ${pc.dim(item.link.root)}`;
				lines.push(
					`  ${item.name.padEnd(width)}  ${pc.dim(item.status)}  ${target}`,
				);
			} else {
				lines.push(`  ${item.name.padEnd(width)}  ${pc.dim(item.status)}`);
			}
		}
	}

	return lines;
}
