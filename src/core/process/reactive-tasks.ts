import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { anySignal, getErrorMessage, startTimer } from "hanzio";
import pc from "picocolors";
import type { ResolvedApp, TaskConfig } from "../../types";
import { childProcessEnv } from "../child-env";
import { registerAbortCleanup } from "../deadline";
import { formatDone, formatStep } from "../style";
import type { AppLife } from "./app-lifecycle";
import { spawnAppCommand } from "./app-process";
import { watchApp } from "./app-watch";
import type { AppState, RunOutput } from "./run-output";
import { terminateOwnedProcess } from "./terminate";

/**
 * Reactive finite one-shot tasks during `buncargo dev` / `env.start()`.
 *
 * Unlike supervised servers/workers, a reactive task runs to completion and
 * exits 0 (e.g. OpenAPI client codegen against a live backend). Each task is
 * single-flight with at most one coalesced follow-up run, reports failures
 * without killing the dev session, and responds to `onAppReady` (initial boot
 * plus restarts), `watch` file edits (disabled by `--no-watch`), or manual
 * triggers (`r` in the TUI, `buncargo run <name>`).
 */

function isReactiveTask(
	task: Pick<TaskConfig, "onAppReady" | "watch">,
): boolean {
	return (
		(task.onAppReady !== undefined && task.onAppReady.length > 0) ||
		task.watch !== undefined
	);
}

/**
 * Reactive tasks active for a run whose startable/reused apps are
 * `selectedApps` and whose selected services are `selectedServices`.
 */
export function selectReactiveTasks(
	tasks: Readonly<Record<string, TaskConfig>> | undefined,
	selectedApps: ReadonlySet<string>,
	selectedServices?: ReadonlySet<string>,
): Record<string, TaskConfig> {
	if (!tasks) return {};

	const active: Record<string, TaskConfig> = {};
	for (const [name, task] of Object.entries(tasks)) {
		if (!isReactiveTask(task)) continue;
		if (task.app !== undefined && !selectedApps.has(task.app)) continue;

		const appsReady =
			!task.onAppReady ||
			task.onAppReady.every((appName) => selectedApps.has(appName));
		const servicesReady =
			selectedServices === undefined ||
			!task.requiredServices ||
			task.requiredServices.every((svc) => selectedServices.has(svc));
		if (!appsReady || !servicesReady) continue;

		active[name] = task;
	}

	return active;
}

interface ReactiveTaskRunnerOptions {
	root: string;
	apps: Readonly<Record<string, Pick<ResolvedApp, "cwd">>>;
	tasks: Readonly<Record<string, TaskConfig>>;
	/** Fresh environment for one run of `task` (active profile, live URLs, secrets). */
	buildEnv: (
		task: TaskConfig,
		signal: AbortSignal,
	) => Record<string, string> | Promise<Record<string, string>>;
	output: RunOutput;
	signal: AbortSignal;
	/** Whether to arm `task.watch` file watchers (`--no-watch` passes `false`). */
	watch?: boolean;
	/** Apps already healthy before this session spawned (e.g. reused apps). */
	initialReadyApps?: readonly string[];
	unsetEnv?: readonly string[];
	shutdownGraceMs?: number;
}

interface TaskRuntime {
	readonly name: string;
	readonly task: TaskConfig;
	readonly cwd: string;
	running: boolean;
	pendingReason?: string;
	activeChild?: ChildProcess;
	activePromise?: Promise<void>;
	/** Prevents `arm()` from double-triggering tasks already fired by wave readiness. */
	triggeredInitialReady: boolean;
}

/**
 * Coordinates reactive one-shot tasks for one dev session: `onAppReady`
 * triggers (initial + restarts), `watch` file triggers, manual `trigger()`
 * (TUI `r`), single-flight coalescing, and clean cancellation on shutdown.
 */
export class ReactiveTaskRunner {
	private readonly entries = new Map<string, TaskRuntime>();
	private readonly readyApps: Set<string>;
	private readonly stopController = new AbortController();
	private readonly signal: AbortSignal;
	private armed = false;

	constructor(private readonly options: ReactiveTaskRunnerOptions) {
		this.readyApps = new Set(options.initialReadyApps ?? []);
		this.signal = anySignal(options.signal, this.stopController.signal);

		for (const [name, task] of Object.entries(options.tasks)) {
			const appCwd = task.app ? options.apps[task.app]?.cwd : undefined;
			const cwd = resolve(options.root, task.cwd ?? appCwd ?? ".");
			this.entries.set(name, {
				name,
				task,
				cwd,
				running: false,
				triggeredInitialReady: false,
			});

			// `restartable: false` keeps stream mode from printing a failure banner
			// for the initial idle state before the task has ever run.
			this.setState(name, "stopped", "idle", false);
		}
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	/** Observe an app's supervision lifecycle step; triggers `onAppReady` tasks when ready. */
	onAppPhase(
		appName: string,
		phase: AppLife["phase"],
		previous: AppLife["phase"],
	): void {
		if (this.signal.aborted) return;

		if (phase === "ready") {
			this.readyApps.add(appName);
			if (previous === "ready") return;

			for (const entry of this.entries.values()) {
				const waiting = entry.task.onAppReady;
				if (!waiting || !waiting.includes(appName)) continue;
				if (waiting.every((dep) => this.readyApps.has(dep))) {
					entry.triggeredInitialReady = true;
					void this.trigger(entry.name, `${appName} ready`);
				}
			}
			return;
		}

		if (phase === "restarting" || phase === "starting" || phase === "down") {
			this.readyApps.delete(appName);
		}
	}

	/**
	 * Arm file watchers (unless `--no-watch`) and trigger any `onAppReady` task
	 * whose prerequisite apps were already healthy via reuse.
	 */
	arm(): void {
		if (this.armed || this.signal.aborted) return;
		this.armed = true;

		for (const entry of this.entries.values()) {
			const waiting = entry.task.onAppReady;
			if (
				waiting &&
				!entry.triggeredInitialReady &&
				waiting.every((dep) => this.readyApps.has(dep))
			) {
				entry.triggeredInitialReady = true;
				void this.trigger(entry.name, `${waiting.join(", ")} ready`);
			}

			if (this.options.watch !== false && entry.task.watch) {
				watchApp({
					name: entry.name,
					dir: entry.cwd,
					config: entry.task.watch,
					signal: this.signal,
					onChange: (reason) => {
						void this.trigger(entry.name, reason);
					},
				});
			}
		}
	}

	/**
	 * Trigger one task. If it is already running, coalesce at most one
	 * follow-up run with the latest reason. Returns `true` when accepted.
	 */
	trigger(name: string, reason = "requested"): boolean {
		if (this.signal.aborted) return false;
		const entry = this.entries.get(name);
		if (!entry) return false;

		if (entry.running) {
			entry.pendingReason = reason;
			return true;
		}

		entry.running = true;
		const loop = this.runLoop(entry, reason).finally(() => {
			entry.running = false;
			if (entry.activePromise === loop) entry.activePromise = undefined;
		});
		entry.activePromise = loop;
		return true;
	}

	/** Stop watchers, cancel pending env/spawns, terminate active children, and await settlement. */
	async stop(): Promise<void> {
		this.stopController.abort();

		const children = [...this.entries.values()].flatMap((entry) => {
			entry.pendingReason = undefined;
			return entry.activeChild ? [entry.activeChild] : [];
		});
		await Promise.allSettled(
			children.map((child) =>
				terminateOwnedProcess(child, this.options.shutdownGraceMs),
			),
		);

		const inflight = [...this.entries.values()].flatMap((entry) =>
			entry.activePromise ? [entry.activePromise] : [],
		);
		await Promise.allSettled(inflight);
	}

	private setState(
		name: string,
		state: AppState,
		detail: string,
		restartable = true,
	): void {
		this.options.output.state(name, {
			state,
			detail,
			restartable,
			rerunCommand: `buncargo run ${name}`,
		});
	}

	private async runLoop(
		entry: TaskRuntime,
		initialReason: string,
	): Promise<void> {
		let nextReason: string | undefined = initialReason;

		while (nextReason !== undefined && !this.signal.aborted) {
			const reason = nextReason;
			nextReason = undefined;
			await this.executeOnce(entry, reason);

			if (entry.pendingReason !== undefined && !this.signal.aborted) {
				nextReason = entry.pendingReason;
				entry.pendingReason = undefined;
			}
		}
	}

	private async executeOnce(entry: TaskRuntime, reason: string): Promise<void> {
		const { name, task, cwd } = entry;
		const { output, unsetEnv, shutdownGraceMs } = this.options;
		const signal = this.signal;
		const elapsed = startTimer();

		this.setState(name, "starting", "running");

		const screen = output.terminals === "pty" ? output.screen(name) : undefined;
		if (screen) {
			// AppScreen feeds committed rows to Overview and `<task>.log`; stream
			// mode has no screen and uses `announce` instead to avoid duplicates.
			screen.write(pc.dim(`── running ${name} (${reason}) ──\r\n`));
		} else {
			output.announce(name, `running (${reason})`, {
				raw: formatStep(`⚙️  Running ${name} (${reason})`),
			});
		}

		const reportError = async (message: string, detail: string) => {
			if (screen) {
				screen.write(`${pc.red(message)}\r\n`);
				await screen.flush();
			} else {
				output.event(name, message, "error");
			}
			this.setState(name, "failed", detail);
		};

		let envVars: Record<string, string>;
		try {
			envVars = await this.options.buildEnv(task, signal);
		} catch (error) {
			if (signal.aborted) return;
			await reportError(getErrorMessage(error), "env error");
			return;
		}
		if (signal.aborted) return;

		let child: ChildProcess;
		try {
			child = spawnAppCommand(task.command, {
				cwd,
				env: childProcessEnv({ ...process.env, ...envVars }, unsetEnv),
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			if (signal.aborted) return;
			await reportError(getErrorMessage(error), "spawn error");
			return;
		}

		entry.activeChild = child;

		const pipeToScreen = (stream: NodeJS.ReadableStream | null) => {
			if (!stream || !screen) return;
			stream.on("data", (chunk: Buffer | string) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				// Normalize bare LF to CRLF for xterm.js without doubling existing CRLF.
				screen.write(text.replace(/\r?\n/g, "\r\n"));
			});
		};

		if (screen) {
			pipeToScreen(child.stdout);
			pipeToScreen(child.stderr);
		} else {
			output.pipe(name, child.stdout);
			output.pipe(name, child.stderr);
		}

		const onAbort = () =>
			registerAbortCleanup(
				signal,
				terminateOwnedProcess(child, shutdownGraceMs),
			);
		signal.addEventListener("abort", onAbort, { once: true });

		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let spawnError: Error | undefined;
		try {
			await new Promise<void>((resolveExit) => {
				child.once("error", (error) => {
					spawnError = error;
					resolveExit();
				});
				child.once("close", (code, sig) => {
					exitCode = code;
					exitSignal = sig;
					resolveExit();
				});
			});
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (entry.activeChild === child) entry.activeChild = undefined;
		}

		if (screen) await screen.flush();
		if (signal.aborted) return;

		const durationMs = Math.round(elapsed());
		if (spawnError) {
			await reportError(spawnError.message, "error");
			return;
		}

		if (exitCode === 0) {
			this.setState(name, "ready", "ok");
			if (screen) {
				screen.write(pc.green(`✓ ${name} finished (${durationMs}ms)\r\n`));
				await screen.flush();
			} else {
				output.announce(name, `finished (${durationMs}ms)`, {
					raw: formatDone(`${name} finished (${durationMs}ms)`),
				});
			}
			return;
		}

		const detail = exitSignal
			? `signal ${exitSignal}`
			: `exit ${exitCode ?? 1}`;
		this.setState(name, "failed", detail);
	}
}
