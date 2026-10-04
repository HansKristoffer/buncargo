import type { DevServerPids } from "../../types";
import { formatPidLine, formatStep } from "../style";
import type { DetachedApp } from "./detached-app";
import { ProcessOwner, RunInterrupted } from "./process-owner";
import type { AppChild } from "./pty-app";
import { terminateOwnedProcess } from "./terminate";

const activeSessions = new Map<number, AppSupervision>();

/** Process ownership and replacement, independent of spawning, output and readiness. */
export class AppSupervision {
	readonly owner: ProcessOwner;
	readonly pids: DevServerPids = {};
	private children = new Map<string, AppChild | DetachedApp>();
	private spawners = new Map<
		string,
		{
			spawn(): Promise<AppChild>;
			worker: boolean;
			attached: boolean;
			port?: number;
		}
	>();
	private restarts = new Set<Promise<void>>();
	/** Per app: the restart in flight, and one waiting behind it. */
	private running = new Map<string, Promise<void>>();
	private queued = new Map<string, Promise<void>>();
	private cleanup?: Promise<void>;

	constructor(
		private options: ConstructorParameters<typeof ProcessOwner>[0] & {
			verbose?: boolean;
			width: number;
			onAppSpawned?: (name: string, pid: number, attached: boolean) => void;
			/** Replaces the console line a restart prints. */
			onRestart?: (name: string, reason: string) => void;
		},
	) {
		this.owner = new ProcessOwner({
			...options,
			onAppAdopted: (name, child) => {
				const old = this.pids[name];
				if (old) activeSessions.delete(old);
				this.children.set(name, child);
				this.pids[name] = child.pid;
				activeSessions.set(child.pid, this);
				options.onAppSpawned?.(name, child.pid, false);
				options.onAppAdopted?.(name, child);
			},
		});
	}

	setSpawner(
		name: string,
		spawn: () => Promise<AppChild>,
		worker: boolean,
		attached: boolean,
		port?: number,
	): void {
		this.spawners.set(name, { spawn, worker, attached, port });
	}

	async register(
		name: string,
		child: AppChild,
		worker: boolean,
		attached: boolean,
		needsReadiness: boolean,
		port?: number,
	): Promise<void> {
		// An async worker claim can finish while stop is cancelling this session.
		if (this.owner.controller.signal.aborted) {
			await terminateOwnedProcess(child, this.options.shutdownGraceMs);
			this.owner.controller.signal.throwIfAborted();
		}
		this.owner.register(name, child, needsReadiness, worker, port);
		this.children.set(name, child);
		if (!child.pid) return;
		this.pids[name] = child.pid;
		activeSessions.set(child.pid, this);
		this.options.onAppSpawned?.(name, child.pid, attached);
		if (this.options.verbose)
			console.log(formatPidLine(name, child.pid, this.options.width));
	}

	/**
	 * Replace one app. Restarts of the same app run one after another: two at
	 * once would both retire the same child and both spawn a replacement, and
	 * the second fails on the port the first just bound. A request arriving
	 * while one is still waiting its turn joins that one.
	 */
	restart(
		name: string,
		reason = "a value it restarts on changed",
	): Promise<void> {
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

	private async replace(name: string, reason: string): Promise<void> {
		const current = this.children.get(name);
		const spawner = this.spawners.get(name);
		if (!current || !spawner || this.owner.controller.signal.aborted) return;
		this.options.onRestart?.(name, reason);
		if (!this.options.onRestart)
			console.log(formatStep(`🔁 Restarting ${name}: ${reason}`));
		await this.owner.retire(current);
		if (current.pid) activeSessions.delete(current.pid);
		this.owner.controller.signal.throwIfAborted();
		const child = await spawner.spawn();
		await this.register(
			name,
			child,
			spawner.worker,
			spawner.attached,
			false,
			spawner.port,
		);
	}

	/**
	 * Stop one app without replacing it. Its exit is reported like any other,
	 * so an app that is optional by then is parked rather than ending the run.
	 */
	async stopApp(name: string): Promise<void> {
		const child = this.children.get(name);
		if (child) await terminateOwnedProcess(child, this.options.shutdownGraceMs);
	}

	stop(): Promise<void> {
		this.cleanup ??= (async () => {
			this.owner.controller.abort(new RunInterrupted("Run stopped"));
			await Promise.allSettled([...this.restarts]);
			await this.owner.stop();
		})().finally(() => this.dispose());
		return this.cleanup;
	}

	dispose(): void {
		for (const pid of Object.values(this.pids)) activeSessions.delete(pid);
		this.children.clear();
		this.spawners.clear();
		this.owner.dispose();
	}
}

export async function stopDevServers(pids: DevServerPids): Promise<void> {
	const sessions = new Set(
		Object.values(pids).flatMap((pid) => activeSessions.get(pid) ?? []),
	);
	const results = await Promise.allSettled(
		[...sessions].map((session) => session.stop()),
	);
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (errors.length)
		throw new AggregateError(errors, "Failed to stop owned app sessions");
}
