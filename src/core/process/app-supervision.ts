import { toError } from "hanzio";
import { abortError, withSignal } from "../deadline";
import {
	type AppEvent,
	AppFailure,
	type AppLife,
	afterExit,
	initialLife,
	RunInterrupted,
	runVerdict,
	transition,
} from "./app-lifecycle";
import { DetachedApp, findDetachedApp } from "./detached-app";
import type { AppChild } from "./pty-app";
import {
	ownedProcessAlive,
	ownedProcessGone,
	terminateOwnedProcess,
} from "./terminate";

/** A process this run owns: one it spawned, or a server one of those left running detached. */
type OwnedChild = AppChild | DetachedApp;

/** The events supervision listens for, which every kind of owned child emits. */
interface OwnedChildEvents {
	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
}

function events(child: OwnedChild): OwnedChildEvents {
	return child;
}

const activeSessions = new Map<number, AppSupervision>();

/** What the supervisor knows of an app before it spawns. */
export interface SupervisedApp {
	/** `essential: false`: its going down never ends the run. */
	optional: boolean;
	worker: boolean;
	/** Has a readiness check (a health endpoint or `readyWhen`) to pass. */
	checked: boolean;
	attached: boolean;
	/** Where a launcher that exits 0 may have left its server. Not for workers. */
	port?: number;
	/** Its `stopGraceMs`. */
	graceMs?: number;
	/** Apps it waits for (`startAfter`): its run cannot go on without them. */
	startAfter?: readonly string[];
}

interface Entry {
	readonly spec: SupervisedApp;
	spawn?: () => Promise<AppChild>;
	/** The current or last process: a parked app restarts from it. */
	child?: OwnedChild;
	life: AppLife;
	/** Aborted when the current process exits or is replaced. */
	process: AbortController;
}

export interface AppSupervisionOptions {
	/** The run: aborting it stops every app. */
	signal?: AbortSignal;
	shutdownGraceMs?: number;
	/**
	 * Every step of an app's life, after it is taken. A promise returned for
	 * `restarting` is awaited before the replacement spawns (alongside the
	 * retire); its rejection does not stop the restart.
	 */
	onPhase?: (
		name: string,
		life: AppLife,
		previous: AppLife,
		event: AppEvent,
	) => void | Promise<void>;
	/** Something worth telling the user about an app (a server it detached). */
	onNotice?: (name: string, text: string) => void;
	/**
	 * Spare the others when an essential app does not come up or cannot be
	 * restarted: park it, unless that ends the run (`runVerdict`).
	 */
	keepOthersOnFailure?: boolean;
}

/**
 * The one owner of a run's apps: each app's spec, process and life. It
 * spawns, retires, adopts and stops processes, applies every lifecycle step
 * and decides what an app going down does to the run.
 */
export class AppSupervision {
	readonly controller = new AbortController();
	readonly pids: Record<string, number> = {};
	private apps = new Map<string, Entry>();
	/** Every process it started, until its group is gone. */
	private children = new Set<OwnedChild>();
	private live = new Set<OwnedChild>();
	private retired = new Set<OwnedChild>();
	/** Every child a restart retired, also once its exit has been handled. */
	private replaced = new WeakSet<OwnedChild>();
	/** The handling of each child's exit, while it runs. */
	private exits = new Map<OwnedChild, Promise<void>>();
	private restarts = new Set<Promise<boolean>>();
	/** Per app: the restart in flight, and one waiting behind it. */
	private running = new Map<string, Promise<boolean>>();
	private queued = new Map<string, Promise<boolean>>();
	private warnedDetaches = new Set<string>();
	private sealed = false;
	private readonly done = Promise.withResolvers<void>();
	private cleanup?: Promise<void>;
	/** What a handed-off session still does once stopped: its output's last flush. */
	private closing: Promise<void> = Promise.resolve();
	private readonly onAbort = () =>
		this.controller.abort(abortError(this.options.signal));

	constructor(
		apps: Readonly<Record<string, SupervisedApp>>,
		private options: AppSupervisionOptions = {},
	) {
		for (const [name, spec] of Object.entries(apps))
			this.apps.set(name, {
				spec,
				life: initialLife(spec),
				process: new AbortController(),
			});
		if (options.signal?.aborted) this.onAbort();
		else
			options.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	life(name: string): AppLife {
		return this.entry(name).life;
	}

	lives(): ReadonlyMap<string, AppLife> {
		return new Map([...this.apps].map(([name, entry]) => [name, entry.life]));
	}

	/** Aborted, with the reason, when the app's current process exits or is replaced. */
	processSignal(name: string): AbortSignal {
		return this.entry(name).process.signal;
	}

	/** How long one app gets between SIGTERM and SIGKILL. */
	graceFor(name: string): number | undefined {
		return this.apps.get(name)?.spec.graceMs ?? this.options.shutdownGraceMs;
	}

	race<T>(operation: Promise<T>): Promise<T> {
		return withSignal(operation, this.controller.signal);
	}

	setSpawner(name: string, spawn: () => Promise<AppChild>): void {
		this.entry(name).spawn = spawn;
	}

	/** Another process serves its port: it comes up like a spawned app. */
	reuse(name: string, probation: boolean): void {
		const entry = this.entry(name);
		entry.process = new AbortController();
		this.apply(name, { type: "reused", probation });
	}

	async register(
		name: string,
		child: AppChild,
		options: { probation: boolean },
	): Promise<void> {
		// An async worker claim can finish while stop is cancelling this session.
		if (this.controller.signal.aborted) {
			await terminateOwnedProcess(child, this.graceFor(name));
			this.controller.signal.throwIfAborted();
		}
		this.own(name, child);
		if (!child.pid) return;
		this.track(name, child.pid);
		this.apply(name, {
			type: "spawned",
			pid: child.pid,
			probation: options.probation,
		});
	}

	/**
	 * Its process passed its check. Only the process that was checked: a
	 * later generation, or one that exited meanwhile, is not promoted.
	 */
	ready(name: string, generation: number): boolean {
		const { life } = this.entry(name);
		if (life.generation !== generation || this.controller.signal.aborted)
			return false;
		const comingUp = life.phase === "starting" || life.phase === "reused";
		if (comingUp) this.apply(name, { type: "ready" });
		return comingUp;
	}

	/**
	 * These apps did not come up (or could not be restarted). Each is stopped
	 * and parked when the run spares it; otherwise the run ends with the
	 * failure. Decided for all of them at once, before anything is parked.
	 */
	async fail(failures: readonly AppFailure[]): Promise<void> {
		if (failures.length === 0 || this.controller.signal.aborted) return;
		const ending = this.endingFailure(failures);
		for (const failure of failures) {
			const park = ending === undefined;
			this.apply(failure.app, { type: "failed", failure, park });
		}
		if (ending) {
			this.controller.abort(ending);
			return;
		}
		// Its exit keeps the reason above.
		await Promise.all(
			failures.map(({ app }) => {
				const { child } = this.entry(app);
				return child && this.live.has(child)
					? terminateOwnedProcess(child, this.graceFor(app))
					: undefined;
			}),
		);
	}

	/** The error the run ends with if these apps go down, or `undefined`. */
	private endingFailure(
		failures: readonly AppFailure[],
	): AppFailure | undefined {
		const essential = failures.filter(
			({ app }) => this.entry(app).life.standing !== "optional",
		);
		if (essential.length === 0) return undefined;
		if (!this.options.keepOthersOnFailure) return essential[0];
		const lives = new Map(this.lives());
		for (const failure of essential)
			lives.set(
				failure.app,
				transition(this.entry(failure.app).life, {
					type: "failed",
					failure,
					park: true,
				}),
			);
		const verdict = runVerdict(
			lives,
			(name) => this.apps.get(name)?.spec.startAfter,
		);
		if (!verdict.ends) return undefined;
		const cause =
			essential.find(({ app }) => app === verdict.app) ?? essential[0];
		if (!cause || verdict.dependents.length === 0) return cause;
		const verb = verdict.dependents.length === 1 ? "starts" : "start";
		const waiting = `${verdict.dependents.join(", ")} ${verb} after ${verdict.app}`;
		return new AppFailure(
			cause.app,
			cause.kind,
			`${cause.message} (${waiting})`,
			{ cause },
		);
	}

	/**
	 * Replace one app. Restarts of the same app run one after another: two at
	 * once would both retire the same child and both spawn a replacement, and
	 * the second fails on the port the first just bound. A request arriving
	 * while one is still waiting its turn joins that one. Resolves to whether
	 * the app was replaced: not when it has no process of this session's (a
	 * reused one) or the run is ending.
	 */
	restart(
		name: string,
		reason = "a value it restarts on changed",
	): Promise<boolean> {
		const queued = this.queued.get(name);
		if (queued) return queued;
		const previous = this.running.get(name) ?? Promise.resolve();
		const operation = previous
			.catch(() => {})
			.then(() => {
				this.queued.delete(name);
				return this.replace(name, reason);
			});
		this.queued.set(name, operation);
		this.running.set(name, operation);
		void operation
			.finally(() => {
				if (this.running.get(name) === operation) this.running.delete(name);
			})
			.catch(() => {});
		this.restarts.add(operation);
		void operation
			.finally(() => this.restarts.delete(operation))
			.catch(() => {});
		return operation;
	}

	private async replace(name: string, reason: string): Promise<boolean> {
		const entry = this.apps.get(name);
		const current = entry?.child;
		if (!entry || !current || !entry.spawn || this.controller.signal.aborted)
			return false;
		entry.process.abort(new Error(`App "${name}" is restarting: ${reason}`));
		const beforeSpawn = Promise.resolve(
			this.apply(name, { type: "restarting", reason }),
		).catch(() => {});
		// From here the app's row says it is restarting: every way this ends
		// moves it on, a retire that fails included.
		try {
			await this.retire(current);
			await beforeSpawn;
			this.controller.signal.throwIfAborted();
			const child = await entry.spawn();
			await this.register(name, child, { probation: false });
		} catch (error) {
			// A run that is ending reports its apps itself.
			if (!this.controller.signal.aborted) {
				const message = `App "${name}" could not be restarted: ${toError(error).message}`;
				const failure = new AppFailure(name, "restart", message, {
					cause: error,
				});
				await this.fail([failure]);
			}
			throw error;
		}
		return true;
	}

	/**
	 * Stop one child because it is being replaced. Its exit is not reported,
	 * and does not end the run the way an app falling over does.
	 */
	async retire(child: OwnedChild): Promise<void> {
		this.retired.add(child);
		this.replaced.add(child);
		// An exit already being handled may be adopting the server it left
		// behind: settled first, so that server is stopped too.
		await this.exits.get(child)?.catch(() => {});
		await terminateOwnedProcess(child, this.graceOf(child));
		if (child instanceof DetachedApp) {
			child.dispose();
			this.live.delete(child);
			this.retired.delete(child);
		}
		this.children.delete(child);
		if (child.exitCode !== null || child.signalCode !== null)
			this.retired.delete(child);
	}

	/** Resolves once nothing is left running or waiting for a restart. */
	async wait(): Promise<void> {
		this.sealed = true;
		this.settleIfDone();
		await this.race(this.done.promise);
	}

	/**
	 * Work that ends a session handed off to run in the background, after it
	 * stops. {@link stopDevServers} waits for it, or a library caller's process
	 * exits before its apps' last words are printed.
	 */
	closeWith(closing: Promise<void>): void {
		this.closing = closing;
	}

	closed(): Promise<void> {
		return this.closing;
	}

	stop(): Promise<void> {
		this.cleanup ??= (async () => {
			this.controller.abort(new RunInterrupted("Run stopped"));
			await Promise.allSettled([...this.restarts]);
			await Promise.allSettled([...this.exits.values()]);
			const results = await Promise.allSettled(
				[...this.children].map((child) =>
					terminateOwnedProcess(child, this.graceOf(child)),
				),
			);
			await Promise.allSettled([...this.exits.values()]);
			const errors = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (errors.length)
				throw new AggregateError(errors, "Failed to stop owned app processes");
		})().finally(() => this.dispose());
		return this.cleanup;
	}

	dispose(): void {
		for (const pid of Object.values(this.pids))
			if (activeSessions.get(pid) === this) activeSessions.delete(pid);
		for (const child of this.children)
			if (child instanceof DetachedApp) child.dispose();
		this.options.signal?.removeEventListener("abort", this.onAbort);
	}

	private entry(name: string): Entry {
		const entry = this.apps.get(name);
		if (!entry) throw new Error(`App "${name}" is not supervised by this run`);
		return entry;
	}

	private apply(name: string, event: AppEvent): void | Promise<void> {
		const entry = this.entry(name);
		const previous = entry.life;
		entry.life = transition(previous, event);
		try {
			return this.options.onPhase?.(name, entry.life, previous, event);
		} catch {
			/* Observers cannot break supervision. */
		}
	}

	/** Start owning a process of `name`, and act on its exit. */
	private own(name: string, child: OwnedChild): void {
		const entry = this.entry(name);
		entry.child = child;
		entry.process = new AbortController();
		this.children.add(child);
		this.live.add(child);
		events(child).once("error", (error) => {
			this.live.delete(child);
			const message = `Failed to start app "${name}": ${error.message}`;
			this.controller.abort(new AppFailure(name, "start", message));
		});
		this.watchExit(name, child);
	}

	private watchExit(name: string, child: OwnedChild): void {
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const operation = this.exited(name, child, { code, signal });
			this.exits.set(child, operation);
			void operation
				.catch((error) => this.controller.abort(error))
				.finally(() => this.exits.delete(child));
		};
		// A child can be gone before it is registered: a worker that crashed
		// while its ownership was being claimed. Its exit counts all the same.
		if (child.exitCode !== null || child.signalCode !== null)
			queueMicrotask(() => onExit(child.exitCode, child.signalCode));
		else events(child).once("exit", onExit);
	}

	private async exited(
		name: string,
		child: OwnedChild,
		exit: { code: number | null; signal: NodeJS.Signals | null },
	): Promise<void> {
		// Replaced on purpose (`restartOn`): its exit is not the app's.
		if (this.retired.delete(child)) {
			this.live.delete(child);
			return;
		}
		const entry = this.entry(name);
		if (await this.adoptDetached(name, child, exit)) return;

		this.live.delete(child);
		this.forgetIfGone(child);
		const runEnding = this.controller.signal.aborted;
		const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
		const failure = new AppFailure(
			name,
			"exited",
			`App "${name}" exited with ${how}`,
		);
		entry.process.abort(failure);
		const before = entry.life;
		this.apply(name, { type: "exited", exit, runEnding });
		if (!runEnding) {
			const outcome = afterExit(before, entry.life);
			if (outcome === "fails") this.controller.abort(failure);
			if (outcome === "interrupts")
				this.controller.abort(
					new RunInterrupted(`Attached app "${name}" exited`),
				);
		}
		this.settleIfDone();
	}

	/**
	 * A server that exited 0 may have left its listener running detached (a
	 * daemonizing dev server): that listener is the app from here on.
	 */
	private async adoptDetached(
		name: string,
		child: OwnedChild,
		exit: { code: number | null },
	): Promise<boolean> {
		const { port, worker } = this.entry(name).spec;
		const mayHaveDetached =
			exit.code === 0 &&
			!worker &&
			port !== undefined &&
			child.pid !== undefined &&
			!(child instanceof DetachedApp);
		if (!mayHaveDetached) return false;
		const detached = await findDetachedApp(port, child.pid);
		// A restart retired it while its listener was being looked for: that
		// listener is the old server, and the replacement needs the port.
		// `retire` waits for this.
		if (this.replaced.has(child)) {
			this.retired.delete(child);
			this.live.delete(child);
			if (detached)
				await terminateOwnedProcess(detached.child, this.graceFor(name));
			return true;
		}
		if (!detached) return false;
		this.live.delete(child);
		this.forgetIfGone(child);
		const server = detached.child;
		this.entry(name).child = server;
		this.children.add(server);
		this.live.add(server);
		this.watchExit(name, server);
		this.track(name, server.pid);
		this.apply(name, { type: "adopted", pid: server.pid });
		if (!this.warnedDetaches.has(name)) {
			this.warnedDetaches.add(name);
			this.options.onNotice?.(
				name,
				`App "${name}" on port ${port}, pid ${server.pid} (${detached.command ?? "unknown command"}): the app detached from buncargo; it will be stopped with the run`,
			);
		}
		if (this.controller.signal.aborted)
			await terminateOwnedProcess(server, this.graceFor(name));
		else server.watch();
		return true;
	}

	/**
	 * Done once nothing runs, no restart is under way, and no spared app is
	 * down waiting for one.
	 */
	private settleIfDone(): void {
		if (!this.sealed || this.live.size > 0) return;
		for (const { life } of this.apps.values()) {
			const waitingForRestart =
				life.phase === "down" &&
				(life.standing === "optional" || life.standing === "parked");
			if (waitingForRestart || life.phase === "restarting") return;
		}
		this.done.resolve();
	}

	/**
	 * A child whose exit was seen and whose group is gone has nothing left to
	 * stop, and its pid may already belong to an unrelated process. A group
	 * that outlives its leader is forgotten once it empties.
	 */
	private forgetIfGone(child: OwnedChild): void {
		if (!ownedProcessAlive(child)) this.children.delete(child);
		else void ownedProcessGone(child).then(() => this.children.delete(child));
	}

	private graceOf(child: OwnedChild): number | undefined {
		for (const [name, entry] of this.apps)
			if (entry.child === child) return this.graceFor(name);
		return this.options.shutdownGraceMs;
	}

	/**
	 * The app's current pid, and the one {@link stopDevServers} finds this
	 * session by. An app's last pid stays until another replaces it, also once
	 * the process is gone: a session whose apps are all parked or failed to
	 * restart is still running, and its caller's pids are how it is stopped.
	 */
	private track(name: string, pid: number): void {
		const previous = this.pids[name];
		if (previous !== undefined && activeSessions.get(previous) === this)
			activeSessions.delete(previous);
		this.pids[name] = pid;
		activeSessions.set(pid, this);
	}
}

export async function stopDevServers(
	pids: Readonly<Record<string, number>>,
): Promise<void> {
	const sessions = new Set(
		Object.values(pids).flatMap((pid) => activeSessions.get(pid) ?? []),
	);
	const results = await Promise.allSettled(
		[...sessions].map(async (session) => {
			try {
				await session.stop();
			} finally {
				await session.closed();
			}
		}),
	);
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (errors.length)
		throw new AggregateError(errors, "Failed to stop owned app sessions");
}
