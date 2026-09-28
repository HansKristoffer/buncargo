import { findMonorepoRoot } from "../../core/ports";
import { findRunsByRoot, type RunAppEntry } from "../../core/run-registry";
import { sleep } from "../../core/sleep";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "../command-spec";
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

/** 0 healthy · 1 failed or stopped · 2 timed out waiting. */
const WAIT_EXIT = { ok: 0, failed: 1, timeout: 2 } as const;

const POLL_MS = 500;

function isUp(app: RunAppEntry | undefined): boolean {
	return app?.status === "ready" || app?.status === "reused";
}

function isDown(app: RunAppEntry | undefined): boolean {
	return app?.status === "failed" || app?.status === "stopped";
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
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);

	try {
		for (;;) {
			const found = await findApp(root, name);
			if (isUp(found?.app)) break;
			if (isDown(found?.app)) {
				log.error(`${name} is ${found?.app.status}.`);
				return WAIT_EXIT.failed;
			}
			if (stopping) return WAIT_EXIT.failed;
			if (Date.now() >= deadline) {
				log.error(
					found
						? `${name} did not become healthy within ${timeoutSeconds}s.`
						: `No buncargo run in ${root} has an app named ${name}.`,
				);
				return WAIT_EXIT.timeout;
			}
			await sleep(POLL_MS);
		}

		if (!readBooleanFlag(args, FLAGS.hold)) return WAIT_EXIT.ok;

		// Held until the app or its whole run goes away, or we are told to stop.
		while (!stopping) {
			const found = await findApp(root, name);
			if (!found || isDown(found.app)) break;
			await sleep(POLL_MS * 2);
		}
		return WAIT_EXIT.ok;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
