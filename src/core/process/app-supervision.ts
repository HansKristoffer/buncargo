import type { ChildProcess } from "node:child_process";
import type { DevServerPids } from "../../types";
import { formatPidLine, formatStep } from "../style";
import type { DetachedApp } from "./detached-app";
import { ProcessOwner, RunInterrupted } from "./process-owner";
import { terminateOwnedProcess } from "./terminate";

const activeSessions = new Map<number, AppSupervision>();

/** Process ownership and replacement, independent of spawning, output and readiness. */
export class AppSupervision {
	readonly owner: ProcessOwner;
	readonly pids: DevServerPids = {};
	private children = new Map<string, ChildProcess | DetachedApp>();
	private spawners = new Map<
		string,
		{
			spawn(): Promise<ChildProcess>;
			worker: boolean;
			attached: boolean;
			port?: number;
		}
	>();
	private restarts = new Set<Promise<void>>();
	private cleanup?: Promise<void>;

	constructor(
		private options: ConstructorParameters<typeof ProcessOwner>[0] & {
			verbose?: boolean;
			width: number;
			onAppSpawned?: (name: string, pid: number, attached: boolean) => void;
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
		spawn: () => Promise<ChildProcess>,
		worker: boolean,
		attached: boolean,
		port?: number,
	): void {
		this.spawners.set(name, { spawn, worker, attached, port });
	}

	async register(
		name: string,
		child: ChildProcess,
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

	restart(name: string): Promise<void> {
		const operation = this.replace(name);
		this.restarts.add(operation);
		void operation
			.finally(() => this.restarts.delete(operation))
			.catch(() => {});
		return operation;
	}

	private async replace(name: string): Promise<void> {
		const current = this.children.get(name);
		const spawner = this.spawners.get(name);
		if (!current || !spawner || this.owner.controller.signal.aborted) return;
		console.log(
			formatStep(`🔁 Restarting ${name}: a value it restarts on changed`),
		);
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
