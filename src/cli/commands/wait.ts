import { promiseTimeout } from "hanzio";
import { findMonorepoRoot } from "../../core/ports";
import { findRunsByRoot, type RunAppEntry } from "../../core/run-registry";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "../command-spec";
import { SIGNAL_EXIT } from "../dev-interrupts";
import * as log from "../log";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	app: {
		name: "--app",
		kind: "string",
		valueHint: "=<name>",
		description: "The app to wait for (required)",
		validate: (value: string) => (value ? undefined : "--app requires a name"),
	},
	timeout: {
		name: "--timeout",
		kind: "string",
		valueHint: "=<seconds>",
		description: "Give up after this long; 0 waits forever (default: 120)",
		validate: (value: string) =>
			/^\d+$/.test(value)
				? undefined
				: `--timeout expects whole seconds, got "${value}"`,
	},
	hold: {
		name: "--hold",
		kind: "boolean",
		description: "Once healthy, stay alive until the run stops",
	},
} as const satisfies Record<string, FlagSpec>;

export const WAIT_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo wait --app=<name> [--timeout=<seconds>] [--hold]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "buncargo wait --app=api && bunx playwright test",
			description: "Test once this checkout's API is up",
		},
	],
};

/**
 * 0 healthy · 1 failed or stopped · 2 timed out waiting · 128 + the signal
 * when interrupted (130 Ctrl-C, 143 SIGTERM).
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
export async function handleWait(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(WAIT_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const name = readStringFlag(args, FLAGS.app, errors);
	const timeoutSeconds = Number(
		readStringFlag(args, FLAGS.timeout, errors) ?? 120,
	);
	errors.push(
		...findUnknownFlags(WAIT_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
	);
	if (!name) errors.push("--app is required");
	if (errors.length > 0 || !name) {
		for (const error of errors) log.error(error);
		return WAIT_EXIT.failed;
	}

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

		if (!readBooleanFlag(args, FLAGS.hold)) return WAIT_EXIT.ok;

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
