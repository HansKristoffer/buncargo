import { basename } from "node:path";
import { DirectoryClient, DirectoryError } from "../core/connect/client";
import {
	makeSecret,
	parseConnectionToken,
	relayEndpoint,
	type Snapshot,
	type TargetStatus,
} from "../core/connect/protocol";
import { type SharedTarget, sharedTargets } from "../core/connect/targets";
import {
	type RelayPublisher,
	startRelayPublisher,
} from "../core/connect/transport/publisher";
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
	publisher?: RelayPublisher;
}
export function createDevConnect(
	env: ConnectSource,
	tokens: string[],
	parentSignal: AbortSignal,
	origin = connectionDirectory() as string,
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
	function snapshot(recipient: string): Snapshot {
		return {
			version: 1,
			sessionId,
			project: env.projectPrefix,
			branch: readGitBranch(env.root),
			worktree: env.isWorktree ? basename(env.root) : null,
			primaryApp: primary ?? null,
			endpoint: relayEndpoint(client.origin, recipient, sessionId),
			revision,
			targets: targets.map(({ port: _, ...target }) => ({ ...target })),
		};
	}
	function publish(id: string, state: Recipient) {
		const work = state.pending
			.catch(() => {})
			.then(async () => {
				if (stopped || state.terminal) return;
				const run = snapshot(id);
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
			state.publisher?.close();
		}
	}
	async function run(id: string, state: Recipient) {
		let failures = 0;
		while (!signal.aborted && !state.terminal) {
			try {
				await publish(id, state);
				const key = await client.key();
				signal.throwIfAborted();
				const publisher = startRelayPublisher({
					endpoint: relayEndpoint(client.origin, id, sessionId),
					recipient: id,
					session: sessionId,
					origin: client.origin,
					secret: state.secret,
					key,
					targets,
					signal,
				});
				state.publisher = publisher;
				await publisher.ready;
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
								abortableSleep(30000, waitSignal).then(() => true),
							]),
							signal,
						);
					} finally {
						waitController.abort();
					}
					if (!heartbeat) throw new Error("Relay disconnected");
					await publish(id, state);
				}
			} catch (error) {
				if (signal.aborted) break;
				terminal(error, state);
				failures++;
				if (failures === 1 || state.terminal)
					log.warn(
						`Could not share with recipient ${id}: ${state.terminal ? "token invalid or sharing revoked; copy a fresh token" : "relay unavailable; retrying"}`,
					);
			} finally {
				state.publisher?.close();
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
			for (const s of recipients.values()) s.publisher?.close();
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
