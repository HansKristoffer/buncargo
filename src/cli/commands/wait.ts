import { promiseTimeout } from "hanzio";
import { findMonorepoRoot } from "../../core/ports";
import { findRunsByRoot, type RunAppEntry } from "../../core/run-registry";
import { defineCommand } from "../command-spec";
import { SIGNAL_EXIT } from "../dev-interrupts";
import { argumentsError } from "../errors";
import * as log from "../log";

/**
 * 0 healthy · 1 failed or stopped · 2 timed out waiting · 128 + the signal
 * when interrupted before the app is healthy (130 Ctrl-C, 143 SIGTERM). A
 * signal while `--hold` holds a healthy app exits 0.
 */
const WAIT_EXIT = { ok: 0, failed: 1, timeout: 2 } as const;
const WAIT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type WaitSignal = (typeof WAIT_SIGNALS)[number];

const POLL_MS = 500;

function isUp(app: RunAppEntry | undefined): boolean {
	return app?.status === "ready" || app?.status === "reused";
}

function isDown(app: RunAppEntry | undefined): boolean {
	return app?.status === "failed" || app?.status === "stopped";
}

export type WaitVerdict =
	| { kind: "healthy" }
	| { kind: "down" }
	| { kind: "interrupted"; code: number }
	| { kind: "timed-out" }
	| { kind: "poll-again" };

/**
 * What one poll of the registry means. A signal wins over what the poll
 * read: one that arrived while it read was answered "healthy" when the app
 * came up in that same poll, and "failed" otherwise.
 */
export function waitVerdict(input: {
	app: RunAppEntry | undefined;
	interrupted: WaitSignal | undefined;
	pastDeadline: boolean;
}): WaitVerdict {
	if (input.interrupted !== undefined)
		return { kind: "interrupted", code: SIGNAL_EXIT[input.interrupted] };
	if (isUp(input.app)) return { kind: "healthy" };
	if (isDown(input.app)) return { kind: "down" };
	if (input.pastDeadline) return { kind: "timed-out" };
	return { kind: "poll-again" };
}

async function findApp(root: string, name: string) {
	const runs = await findRunsByRoot(root).catch(() => []);
	// The newest run owns the app when a takeover left two entries behind.
	for (const run of runs.sort((a, b) =>
		b.startedAt.localeCompare(a.startedAt),
	)) {
		const app = run.apps.find((entry) => entry.name === name);
		if (app) return { run, app };
	}
	return undefined;
}

/**
 * Block until an app of this checkout's run is healthy.
 *
 * Reads the run registry, which is `dev`'s own record of readiness, rather
 * than probing: it is the same answer BuncargoBar shows, and it covers apps
 * reused from another terminal. `--hold` then stands in for a process that
 * must stay alive as long as the app does, which is what Shopify CLI's
 * generated web process needs: it treats its web command exiting as a crash.
 */
async function waitFor(
	name: string,
	timeoutSeconds: number,
	hold: boolean,
): Promise<number> {
	const root = findMonorepoRoot();
	const deadline =
		timeoutSeconds === 0
			? Number.POSITIVE_INFINITY
			: Date.now() + timeoutSeconds * 1000;
	// The first signal; it also cuts the sleep between polls short.
	let interrupted: WaitSignal | undefined;
	const stopped = new AbortController();
	const listeners = WAIT_SIGNALS.map((signal) => {
		const listener = () => {
			interrupted ??= signal;
			stopped.abort();
		};
		process.on(signal, listener);
		return { signal, listener };
	});
	const pause = (ms: number) =>
		promiseTimeout(ms, { signal: stopped.signal }).catch(() => {});

	try {
		for (;;) {
			const found = await findApp(root, name);
			const verdict = waitVerdict({
				app: found?.app,
				interrupted,
				pastDeadline: Date.now() >= deadline,
			});
			if (verdict.kind === "healthy") break;
			if (verdict.kind === "interrupted") {
				log.error(`Interrupted while waiting for ${name}.`);
				return verdict.code;
			}
			if (verdict.kind === "down") {
				log.error(`${name} is ${found?.app.status}.`);
				return WAIT_EXIT.failed;
			}
			if (verdict.kind === "timed-out") {
				log.error(
					found
						? `${name} did not become healthy within ${timeoutSeconds}s.`
						: `No buncargo run in ${root} has an app named ${name}.`,
				);
				return WAIT_EXIT.timeout;
			}
			await pause(POLL_MS);
		}

		if (!hold) return WAIT_EXIT.ok;

		// Held until the app or its whole run goes away, or we are told to
		// stop: the way the Shopify CLI ends the web process it runs, so 0.
		while (interrupted === undefined) {
			const found = await findApp(root, name);
			if (!found || isDown(found.app)) break;
			await pause(POLL_MS * 2);
		}
		return WAIT_EXIT.ok;
	} finally {
		for (const { signal, listener } of listeners) process.off(signal, listener);
	}
}

export const waitCommand = defineCommand({
	spec: {
		name: "wait",
		usage: "wait --app=<name> [options]",
		summary: "Block until an app of this checkout's run is healthy",
		flags: {
			app: {
				kind: "string",
				value: "<name>",
				description: "The app to wait for (required)",
			},
			timeout: {
				kind: "string",
				value: "<seconds>",
				description: "Give up after this long; 0 waits forever (default: 120)",
				validate: (value: string) =>
					/^\d+$/.test(value)
						? undefined
						: `--timeout expects whole seconds, got "${value}"`,
			},
			hold: {
				kind: "boolean",
				description: "Once healthy, stay alive until the run stops",
			},
		},
		examples: [
			{
				command: "buncargo wait --app=api && bunx playwright test",
				description: "Test once this checkout's API is up",
			},
		],
	},
	exits: {
		[WAIT_EXIT.ok]: "healthy (and, with --hold, a signal after that)",
		[WAIT_EXIT.failed]: "the app failed or stopped, or bad arguments",
		[WAIT_EXIT.timeout]: "timed out waiting",
		130: "interrupted before the app was healthy (Ctrl-C); 143 for SIGTERM",
	},
	run: ({ values }) => {
		if (values.app === undefined)
			throw argumentsError(["--app is required"], "wait");
		return waitFor(values.app, Number(values.timeout ?? 120), values.hold);
	},
});
