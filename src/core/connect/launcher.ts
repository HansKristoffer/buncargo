import { spawn } from "node:child_process";
import { connectProcessEnv } from "../child-env";
import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { inOwnUserScope } from "../process/user-scope";
import { matchesProcessIdentity } from "../process-identity";
import { stateFilePath } from "../state-paths";
import { installConnectBundle } from "./bundle";
import { request } from "./client";
import {
	type CoordinatorState,
	isCoordinatorReady,
	readCoordinatorState,
} from "./coordinator-state";

/**
 * How many coordinators one ensure adopts or starts. Each that goes away
 * before it reports (it left idle, or another launcher replaced it) is
 * replaced; past this many something keeps ending them, and waiting longer
 * would only hide it.
 */
const ENSURE_ATTEMPTS = 3;

interface LaunchedCoordinator {
	owner: CoordinatorState;
	adopted: boolean;
}

/** Copy a self-contained bundle out of the package cache; one launcher at a time can start it. */
export function ensureConnectCoordinator(signal?: AbortSignal): Promise<void> {
	return ensureCoordinatorWith(() => launchCoordinator(signal), signal);
}

/**
 * Adopt or start a coordinator with `launch`, and wait for it to report. One
 * that went away meanwhile is launched again, up to {@link ENSURE_ATTEMPTS}
 * times.
 */
export async function ensureCoordinatorWith(
	launch: () => Promise<LaunchedCoordinator>,
	signal?: AbortSignal,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const { owner, adopted } = await launch();
		try {
			await awaitCoordinator(owner, adopted, signal);
			return;
		} catch (error) {
			if (!(error instanceof CoordinatorUnavailableError)) throw error;
			if (attempt >= ENSURE_ATTEMPTS)
				throw new Error(
					`The connection coordinator went away ${ENSURE_ATTEMPTS} times before it reported. Run \`buncargo connect status\` to see what is ending it.`,
				);
		}
	}
}

async function launchCoordinator(
	signal?: AbortSignal,
): Promise<LaunchedCoordinator> {
	const bundle = installConnectBundle();
	return withFileLock(
		stateFilePath("connect-launch"),
		async () => {
			const existing = await readCoordinatorState();
			if (existing?.ready) {
				if (existing.bundle !== bundle) {
					throw new Error(
						"A different Buncargo build is sharing services. Stop its dev sessions before starting this build.",
					);
				}
				return { owner: existing, adopted: true };
			}
			if (existing) {
				// It found nothing to share and is exiting; it never reads this run's intent. Its replacement needs its lifetime lock.
				await withFileLock(
					stateFilePath("connect-coordinator"),
					async () => {},
					{ timeoutMs: 3000, signal },
				);
			}
			const [command, ...args] = inOwnUserScope(
				[process.execPath, bundle],
				"buncargo sharing coordinator",
			);
			const child = spawn(command as string, args, {
				detached: true,
				stdio: "ignore",
				env: connectProcessEnv(),
			});
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
			child.unref();
			// Hold the launch lock until the child has published its birth identity. Concurrent worktrees adopt it.
			for (let i = 0; i < 100; i++) {
				const state = await readCoordinatorState(false);
				if (state && state.pid === child.pid) {
					return { owner: state, adopted: false };
				}
				if (child.exitCode !== null) {
					throw new Error("Connection coordinator exited during startup");
				}
				await abortableSleep(50, signal);
			}
			throw new Error("Connection coordinator did not start");
		},
		{ timeoutMs: 5000 },
	);
}

/** A running coordinator heartbeats every second; one silent for this long after adoption is wedged. */
const WEDGED_GRACE_MS = 3000;

/**
 * Wait for `owner`'s fresh heartbeat. An adopted coordinator was adopted on
 * its saved ready flag: it gets a few heartbeats to report (one that just
 * woke from sleep does), and one that does not is wedged, named with its pid,
 * rather than holding every run that adopts it for the whole startup wait.
 * One that reports it is leaving, or that another launcher has replaced
 * (the state names another process), throws
 * {@link CoordinatorUnavailableError}: ensuring again adopts the one there is.
 */
export async function awaitCoordinator(
	owner: CoordinatorState,
	adopted: boolean,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + (adopted ? WEDGED_GRACE_MS : 180000);
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		const state = await readCoordinatorState(false);
		const named = state?.pid === owner.pid && state.identity === owner.identity;
		if (named) {
			if (isCoordinatorReady(state)) {
				return;
			}
			if (!matchesProcessIdentity(state.pid, state.identity)) {
				throw new Error("Connection coordinator stopped during startup");
			}
			if (adopted && !state.ready) {
				throw new CoordinatorUnavailableError();
			}
		} else if (
			state !== undefined ||
			!matchesProcessIdentity(owner.pid, owner.identity)
		) {
			throw new CoordinatorUnavailableError();
		}
		await abortableSleep(250, signal);
	}
	if (!adopted)
		throw new Error(
			"Connection startup timed out. Check relay connectivity and run buncargo connect status.",
		);
	// Its pid may belong to another process by now: name it only while it is
	// still the coordinator.
	if (!matchesProcessIdentity(owner.pid, owner.identity))
		throw new CoordinatorUnavailableError();
	throw new Error(
		`The connection coordinator (pid ${owner.pid}) stopped reporting. End it with \`kill ${owner.pid}\` and start the run again; that starts a new coordinator.`,
	);
}

class CoordinatorUnavailableError extends Error {
	constructor() {
		super("Connection coordinator unavailable");
	}
}

/** The coordinator was not there to answer: refused, reset, or no live state left. */
export function coordinatorWentAway(error: unknown): boolean {
	if (error instanceof CoordinatorUnavailableError) return true;
	// Bun 1.4.2's fetch reports a refused connection as `ConnectionRefused`.
	const code = (error as { code?: unknown } | null)?.code;
	return (
		code === "ECONNREFUSED" ||
		code === "ConnectionRefused" ||
		code === "ECONNRESET"
	);
}

/**
 * One request to the coordinator, launched or adopted first. A command sends
 * no intent, so the coordinator it adopted can still decide to exit idle
 * before the request lands; then it is ensured again, which starts a new one,
 * and the request is sent once more. An error the coordinator answered with
 * is never retried.
 */
export async function requestCoordinator<T>(
	path: string,
	body?: unknown,
	deps: {
		ensure: () => Promise<void>;
		readState: () => Promise<CoordinatorState | undefined>;
		send: typeof request;
	} = {
		ensure: () => ensureConnectCoordinator(),
		readState: () => readCoordinatorState(),
		send: request,
	},
): Promise<T> {
	const attempt = async (): Promise<T> => {
		await deps.ensure();
		const state = await deps.readState();
		if (!state) throw new CoordinatorUnavailableError();
		return deps.send<T>(
			`http://127.0.0.1:${state.connection.port}`,
			path,
			state.connection.token,
			body,
		);
	};

	try {
		return await attempt();
	} catch (error) {
		if (!coordinatorWentAway(error)) throw error;
		return attempt();
	}
}
