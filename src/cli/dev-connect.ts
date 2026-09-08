import { basename } from "node:path";
import { DirectoryClient, DirectoryError } from "../core/connect/client";
import {
	AUTHORIZATION_MS,
	HEARTBEAT_MS,
	makeSecret,
	parseConnectionToken,
	type Snapshot,
	type TargetStatus,
} from "../core/connect/protocol";
import {
	startTailcatPublisher,
	type TailcatPublisher,
} from "../core/connect/tailcat/publisher";
import { type SharedTarget, sharedTargets } from "../core/connect/targets";
import { abortableSleep, withSignal } from "../core/deadline";
import { connectionDirectory } from "../core/runtime-flags";
import type { AppConfig, ServiceConfig } from "../types";
import * as log from "./log";
import { readGitBranch } from "./run-publish";
export interface ConnectSource {
	root: string;
	projectPrefix: string;
	isWorktree: boolean;
	services: Record<string, ServiceConfig>;
	ports: object;
	resolvePrimaryApp(selected?: readonly string[]): string | undefined;
}
interface Recipient {
	token: string;
	secret: string;
	registered: boolean;
	terminal: boolean;
	pending: Promise<void>;
	task?: Promise<void>;
	publisher?: TailcatPublisher;
	leaseTimer?: ReturnType<typeof setTimeout>;
}
export function createDevConnect(
	env: ConnectSource,
	tokens: string[],
	parentSignal: AbortSignal,
	origin = connectionDirectory() as string,
	startPublisher = startTailcatPublisher,
	heartbeatMs = HEARTBEAT_MS,
) {
	const controller = new AbortController(),
		signal = AbortSignal.any([parentSignal, controller.signal]);
	const client = new DirectoryClient(origin),
		recipients = new Map<string, Recipient>();
	for (const token of tokens) {
		const { recipientId, secret } = parseConnectionToken(token);
		recipients.set(recipientId, {
			token: secret,
			secret: makeSecret(),
			registered: false,
			terminal: false,
			pending: Promise.resolve(),
		});
	}
	let targets: SharedTarget[] = [],
		sessionId = "",
		revision = 0,
		primary: string | undefined,
		stopped = false,
		started = false;
	function snapshot(state: Recipient): Snapshot {
		const publisher = state.publisher;
		if (!publisher) throw new Error("Tailcat is not running");
		return {
			version: 1,
			sessionId,
			project: env.projectPrefix,
			branch: readGitBranch(env.root),
			worktree: env.isWorktree ? basename(env.root) : null,
			primaryApp: primary ?? null,
			endpoint: publisher.endpoint,
			transport: "ready",
			revision,
			targets: targets.map((target, i) => ({
				...target,
				port: publisher.targets[i].port,
			})),
		};
	}
	function publish(id: string, state: Recipient) {
		const work = state.pending
			.catch(() => {})
			.then(async () => {
				if (stopped || state.terminal) return;
				const run = snapshot(state);
				try {
					await client.publish(
						id,
						state.registered ? state.secret : state.token,
						state.secret,
						run,
						signal,
					);
				} catch (error) {
					if (
						error instanceof DirectoryError &&
						error.status === 410 &&
						state.registered
					)
						await client.publish(id, state.token, state.secret, run, signal);
					else throw error;
				}
				state.registered = true;
				clearTimeout(state.leaseTimer);
				const publisher = state.publisher;
				state.leaseTimer = setTimeout(() => {
					void publisher?.close().catch(() => {});
				}, AUTHORIZATION_MS);
			});
		state.pending = work;
		return work;
	}
	function terminal(error: unknown, state: Recipient) {
		if (
			error instanceof DirectoryError &&
			[400, 401, 403, 410].includes(error.status)
		) {
			state.terminal = true;
			void state.publisher?.close().catch(() => {});
		}
	}
	async function run(id: string, state: Recipient) {
		let failures = 0;
		while (!signal.aborted && !state.terminal) {
			try {
				const publisher = await startPublisher({ targets, signal });
				state.publisher = publisher;
				revision++;
				await publish(id, state);
				failures = 0;
				log.info(`Shared ${targets.length} targets with recipient ${id}`);
				while (!signal.aborted && !state.terminal) {
					const waitController = new AbortController();
					const waitSignal = AbortSignal.any([signal, waitController.signal]);
					let heartbeat = false;
					try {
						heartbeat = await withSignal(
							Promise.race([
								publisher.exited.then(() => false),
								abortableSleep(heartbeatMs, waitSignal).then(() => true),
							]),
							signal,
						);
					} finally {
						waitController.abort();
					}
					if (!heartbeat) throw new Error("Tailcat disconnected");
					await publish(id, state);
				}
			} catch (error) {
				if (signal.aborted) break;
				terminal(error, state);
				failures++;
				if (failures === 1 || state.terminal)
					log.warn(
						`Could not share with recipient ${id}: ${state.terminal ? "token invalid or sharing revoked; copy a fresh token" : "connection unavailable; retrying"}`,
					);
			} finally {
				clearTimeout(state.leaseTimer);
				await state.publisher?.close();
				state.publisher = undefined;
			}
			if (!signal.aborted && !state.terminal)
				await abortableSleep(
					Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) *
						(0.8 + Math.random() * 0.4),
					signal,
				).catch(() => {});
		}
	}
	return {
		plan(apps: Record<string, AppConfig>, services: readonly string[]) {
			targets = sharedTargets(
				apps,
				env.services,
				env.ports as Record<string, number>,
				services,
			);
			primary = env.resolvePrimaryApp(Object.keys(apps));
			if (!targets.some((t) => t.kind === "app" && t.name === primary))
				primary = undefined;
		},
		get active() {
			return targets.length > 0;
		},
		status(names: string[], status: TargetStatus) {
			for (const target of targets)
				if (target.kind === "app" && names.includes(target.name)) {
					if (
						["stopped", "failed"].includes(target.status) &&
						!["stopped", "failed"].includes(status)
					)
						continue;
					target.status = status;
					if (["stopped", "failed"].includes(status))
						for (const s of recipients.values())
							s.publisher?.disconnectTarget(target.id);
				}
			revision++;
			if (started)
				for (const [id, state] of recipients)
					if (state.registered && !state.terminal)
						void publish(id, state).catch((error) => terminal(error, state));
		},
		start(id: string, reused: string[]) {
			if (started || !targets.length) return;
			started = true;
			sessionId = id;
			for (const t of targets)
				if (t.kind === "app" && reused.includes(t.name)) t.status = "reused";
			for (const [recipient, state] of recipients)
				state.task = run(recipient, state);
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			controller.abort();
			await Promise.allSettled(
				[...recipients.values()].map((s) => s.publisher?.close()),
			);
			await Promise.allSettled(
				[...recipients.values()].flatMap((s) => [s.task, s.pending]),
			);
			if (started)
				await Promise.allSettled(
					[...recipients].map(([id, s]) =>
						client.withdraw(id, sessionId, s.secret),
					),
				);
		},
	};
}
export type DevConnect = ReturnType<typeof createDevConnect>;
