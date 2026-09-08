import {
	type DirectorySnapshot,
	isTargetReady,
	type Registration,
	type RemoteTarget,
} from "./protocol";
import { type Forward, localForward } from "./transport/local-forward";

interface SessionForwards {
	origins: Set<string>;
	targets: Map<string, Forward>;
}

function matches(
	forward: Forward,
	run: Registration,
	target: RemoteTarget,
): boolean {
	return (
		!forward.closed &&
		forward.endpoint === run.endpoint &&
		forward.target.port === target.port &&
		forward.target.protocol === target.protocol
	);
}

/**
 * Own local listeners and browser peers by remote session. The helper serializes all
 * calls so opening siblings, directory reconciliation and disconnect cannot race.
 */
export class ConnectionForwards {
	private readonly sessions = new Map<string, SessionForwards>();

	constructor(private readonly create = localForward) {}

	get size(): number {
		let size = 0;
		for (const session of this.sessions.values()) size += session.targets.size;
		return size;
	}

	async disconnect(sessionId: string, targetId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		const forward = session?.targets.get(targetId);
		if (!session || !forward) return;
		session.targets.delete(targetId);
		if (!session.targets.size) this.sessions.delete(sessionId);
		if (forward.target.protocol === "http")
			session.origins.delete(new URL(forward.url).origin);
		await forward.close();
	}

	async open(run: Registration, targetId: string): Promise<Forward> {
		const target = run.targets.find((t) => t.id === targetId);
		if (run.transport !== "ready" || !target || !isTargetReady(target))
			throw new Error("Remote target unavailable");

		const session = this.sessions.get(run.sessionId) ?? {
			origins: new Set<string>(),
			targets: new Map<string, Forward>(),
		};
		// Bootstrap all ready HTTP siblings so opening the UI also authorizes its API.
		const siblings =
			target.protocol === "http"
				? run.targets.filter((t) => t.protocol === "http" && isTargetReady(t))
				: [target];
		for (const sibling of siblings) {
			const existing = session.targets.get(sibling.id);
			if (existing && matches(existing, run, sibling)) continue;
			await this.disconnect(run.sessionId, sibling.id);
			if (this.size >= 128) throw new Error("Local connection limit reached");
			const forward = await this.create(run.endpoint, sibling, {
				origins: session.origins,
				cookies: () =>
					[...session.targets.values()].flatMap((f) =>
						f.browserCookie ? [f.browserCookie] : [],
					),
			});
			session.targets.set(sibling.id, forward);
			this.sessions.set(run.sessionId, session);
			if (sibling.protocol === "http")
				session.origins.add(new URL(forward.url).origin);
		}
		const forward = session.targets.get(targetId);
		if (!forward) throw new Error("Remote target unavailable");
		return forward;
	}

	/** Retire revoked, stopped or replaced endpoints; never reconnect interrupted streams. */
	async reconcile(directory: DirectorySnapshot): Promise<void> {
		const runs = new Map(directory.runs.map((run) => [run.sessionId, run]));
		for (const [id, session] of this.sessions) {
			const run = runs.get(id);
			for (const [targetId, forward] of session.targets) {
				const target = run?.targets.find((t) => t.id === targetId);
				if (
					!run ||
					run.transport !== "ready" ||
					!target ||
					!isTargetReady(target) ||
					!matches(forward, run, target)
				)
					await this.disconnect(id, targetId);
			}
			if (!session.targets.size) this.sessions.delete(id);
		}
	}

	async close(): Promise<void> {
		const forwards = [...this.sessions.values()].flatMap((s) => [
			...s.targets.values(),
		]);
		this.sessions.clear();
		await Promise.allSettled(forwards.map((forward) => forward.close()));
	}
}
