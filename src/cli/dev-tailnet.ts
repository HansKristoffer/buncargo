import { abortableSleep } from "../core/deadline";
import { matchesProcessIdentity } from "../core/process-identity";
import { readLiveRuns } from "../core/run-registry";
import { isCI } from "../core/runtime-flags";
import { TailnetUnavailableError } from "../core/tailnet/client";
import { tailnetDaemonHealthy } from "../core/tailnet/health";
import { createTailnetRuntime } from "../core/tailnet/runtime";
import { readTailnetState } from "../core/tailnet/state";
import type { AppConfig } from "../types";
import * as log from "./log";

interface TailnetEnv {
	root: string;
	ports: object;
	setTailnetUrls?: (urls: Readonly<Record<string, string | undefined>>) => void;
}

interface TailnetInput {
	requested: boolean | undefined;
	publicExpose: boolean;
	startApps: Record<string, AppConfig>;
	reusedApps: Record<string, AppConfig>;
	sessionId?: string;
	signal?: AbortSignal;
}

const defaults = {
	state: readTailnetState,
	runs: readLiveRuns,
	healthy: tailnetDaemonHealthy,
	runtime: createTailnetRuntime,
	ci: isCI,
	warn: log.warn,
};

/** Decide eligibility without reading persisted state or probing the network. */
export function tailnetSelection(
	env: TailnetEnv,
	input: TailnetInput,
	ci: boolean,
) {
	if (input.requested === true && input.publicExpose)
		throw new Error(
			"Choose --tailnet or --expose for a coherent web/API URL mode",
		);

	const local =
		input.requested === false ||
		(ci && input.requested !== true) ||
		input.publicExpose;

	const ports = env.ports as Record<string, number>;

	const apps = Object.entries({
		...input.startApps,
		...input.reusedApps,
	}).flatMap(([name, app]) => {
		if (
			!app.expose ||
			app.interactive ||
			app.needsPublicUrls ||
			ports[name] === undefined
		)
			return [];

		return [
			{ name, port: ports[name] as number, reused: name in input.reusedApps },
		];
	});

	return { local, apps };
}

export async function prepareTailnet(
	env: TailnetEnv,
	input: TailnetInput,
	overrides: Partial<typeof defaults> = {},
) {
	const deps = { ...defaults, ...overrides };

	input.signal?.throwIfAborted();

	const { local, apps } = tailnetSelection(env, input, deps.ci());
	const reused = Object.keys(input.reusedApps).length > 0;

	// Reused servers already have their URL environment; changing it requires a takeover.
	const remoteReused =
		reused &&
		(await deps.runs()).some(
			(run) =>
				run.root === env.root &&
				run.apps.some(
					(app) =>
						app.name in input.reusedApps &&
						app.tailnetUrl &&
						app.status !== "stopped" &&
						app.status !== "failed",
				),
		);

	const requireLocal = () => {
		if (remoteReused)
			throw new Error(
				"A reused app still has tailnet URLs. Restart with --takeover to change its URL mode.",
			);
	};

	if (local) {
		requireLocal();

		return;
	}

	if (!apps.length) {
		if (input.requested === true)
			throw new Error(
				"No selected HTTP apps have expose: true (interactive/Metro apps are not yet supported)",
			);

		return;
	}

	const state = deps.state();

	if (!state.enabled && input.requested !== true) {
		requireLocal();

		return;
	}

	try {
		if (!state.enabled || state.removing || !(await deps.healthy()))
			throw new TailnetUnavailableError(
				"Tailnet coordinator unavailable. Run buncargo tailnet install.",
			);

		if (!env.setTailnetUrls)
			throw new Error(
				"This DevEnvironment does not support tailnet URLs; update buncargo",
			);

		const runtime = deps.runtime();

		const urls = await runtime.acquire({
			root: env.root,
			apps,
			sessionId: input.sessionId,
			signal: input.signal,
		});

		input.signal?.throwIfAborted();
		env.setTailnetUrls(urls);
		log.info("Private Tailscale URLs:");

		for (const [name, url] of Object.entries(urls))
			log.info(`  ${name}: ${url}`);
	} catch (error) {
		input.signal?.throwIfAborted();

		// Acquisition classifies availability failures only after rolling back its partial mappings.
		// Ownership conflicts and incomplete cleanup must still stop startup.
		if (
			!(error instanceof TailnetUnavailableError) ||
			input.requested === true ||
			remoteReused
		)
			throw error;

		env.setTailnetUrls?.({});
		deps.warn(`${error.message} Continuing with local URLs.`);
	}
}

/** A freed app port can precede its old CLI's asynchronous lease release. */
export async function waitForTailnetHandoff(
	root: string,
	names: string[],
	signal?: AbortSignal,
	deps = {
		state: readTailnetState,
		alive: matchesProcessIdentity,
		sleep: abortableSleep,
		now: Date.now,
	},
) {
	const deadline = deps.now() + 10000;

	for (;;) {
		signal?.throwIfAborted();

		const pending = deps
			.state()
			.allocations.some(
				(a) =>
					a.lease?.root === root &&
					names.includes(a.lease.app) &&
					deps.alive(a.lease.pid, a.lease.identity),
			);

		if (!pending) return;

		if (deps.now() >= deadline)
			throw new Error(
				"Previous run has not released its tailnet mappings. Run buncargo tailnet doctor --repair, then retry.",
			);

		await deps.sleep(100, signal);
	}
}

export async function releaseTailnet(root: string, app?: string) {
	const state = readTailnetState();

	if (
		!state.allocations.some(
			(a) =>
				a.lease?.root === root &&
				a.lease.pid === process.pid &&
				(!app || a.lease.app === app),
		)
	)
		return;

	await createTailnetRuntime().release(root, process.pid, app);
}
