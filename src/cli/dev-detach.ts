import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promiseTimeout } from "hanzio";
import { logsRoot } from "../core/process/app-logs";
import { inOwnUserScope } from "../core/process/user-scope";
import {
	readJsonDocumentSync,
	writeJsonDocumentSync,
} from "../core/registry-file";
import { formatDuration } from "../core/run-limits";
import {
	findRunsByRoot,
	type RunAppEntry,
	type RunEntry,
} from "../core/run-registry";
import { DETACHED_ENV, detachedRunEnv } from "../core/runtime-flags";
import * as log from "./log";
import {
	describeAppFailure,
	formatRunFailure,
	type RunFailure,
} from "./run-failure";

/**
 * `buncargo dev --detach`: the run in the background, the terminal back once
 * its apps are up.
 *
 * Agents ran `nohup buncargo dev & disown` because their harness kills a
 * foreground command after a few minutes, then polled with `sleep` and `until
 * grep`. Here the run is re-executed in its own session (so neither the
 * harness's SIGTERM nor a closed terminal reaches it) and this process waits
 * on the run registry - the same record `wait`, `stop` and BuncargoBar read -
 * until every app has settled.
 */

const POLL_MS = 250;

/** Where a detached run's own output goes; app output is in its run directory. */
export function detachedLogPath(root: string): string {
	return join(logsRoot(root), "detached.log");
}

/**
 * What the background run tells the `dev --detach` waiting on it, which would
 * otherwise have to dig the cause out of the log: the setup checks that
 * warned, and each failure, an app that never came up or the error that ended
 * the run. Written by the run, read once by the parent.
 */
export interface DetachedReport {
	setupHints: string[];
	failures: RunFailure[];
}

export function detachedReportPath(root: string): string {
	return join(logsRoot(root), "detached-report.json");
}

function validateReport(value: unknown): DetachedReport | undefined {
	const report = value as Partial<DetachedReport> | null;
	const valid =
		typeof report === "object" &&
		report !== null &&
		Array.isArray(report.setupHints) &&
		Array.isArray(report.failures);
	return valid ? (report as DetachedReport) : undefined;
}

export function readDetachedReport(root: string): DetachedReport | undefined {
	return readJsonDocumentSync(detachedReportPath(root), validateReport);
}

/**
 * Update the report of the detached run in `root`. Synchronous, so it is on
 * disk before the registry says the app failed, which is what the parent
 * waits for. No lock: the run itself is the one writer, on one thread. A
 * report that cannot be written loses only the explanation.
 */
export function recordDetachedReport(
	root: string,
	update: (report: DetachedReport) => DetachedReport,
): void {
	const current = readDetachedReport(root) ?? {
		setupHints: [],
		failures: [],
	};
	try {
		writeJsonDocumentSync(detachedReportPath(root), update(current));
	} catch {
		// The parent falls back to the log.
	}
}

/** Print a failure block, past Bun's buffer: the parent exits right after. */
function printFailure(failure: RunFailure): void {
	const { message, hints } = formatRunFailure(failure);
	log.errorNow(message, hints);
}

/**
 * Argv for the background run: this same invocation without `--detach` and
 * `--keep`, so a script wrapping `runCli` is re-run the same way `buncargo
 * dev` is. `--keep` reaches the run through `BUNCARGO_DETACHED` instead.
 */
export function detachedArgv(
	argv: readonly string[],
	execPath = process.execPath,
): string[] {
	return [
		execPath,
		...argv.slice(1).filter((arg) => arg !== "--detach" && arg !== "--keep"),
	];
}

/**
 * Every app has settled: up, or down for good. A selection with no app to
 * spawn settles once its services are ready. `expectApps` matters because the
 * run's first claim is written before its apps are, and an empty list is not
 * "done".
 */
export function settledRun(run: RunEntry, expectApps: boolean): boolean {
	if (expectApps)
		return (
			run.apps.length > 0 && run.apps.every((app) => app.status !== "starting")
		);
	return run.services.every((service) => service.status === "ready");
}

function describeApp(app: RunAppEntry): string {
	return `${app.name}: ${app.status}${app.openUrl ? `  ${app.openUrl}` : ""}`;
}

function readLog(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function tail(path: string, lines = 30): string {
	return readLog(path).trimEnd().split("\n").slice(-lines).join("\n");
}

const HOSTS_FALLBACK = "Named URLs unavailable:";

/**
 * Why the run's URLs are `localhost:port`, from its output. The run printed
 * it into the detached log, where nobody looking at the app list would see
 * it, and the fallback is otherwise silent.
 */
export function namedHostsFallbacks(output: string): string[] {
	return Bun.stripANSI(output)
		.split("\n")
		.flatMap((line) => {
			const at = line.indexOf(HOSTS_FALLBACK);
			return at === -1 ? [] : [line.slice(at).trimEnd()];
		});
}

/**
 * Start the run in the background and wait for it. 0 when every app came up,
 * or when the run finished cleanly with nothing left to run (every selected
 * app already running elsewhere, as attached `dev` exits 0 on); 1 when the run
 * failed or an app did not come up (the others keep running).
 */
export async function runDetached(input: {
	root: string;
	/** Whether the selection has apps to spawn and wait for (see {@link settledRun}). */
	expectApps: boolean;
	/** `--keep`: no idle limit. */
	keep: boolean;
	argv?: readonly string[];
	timeoutMs?: number;
}): Promise<number> {
	const { root, expectApps, timeoutMs = 10 * 60_000 } = input;
	const argv = detachedArgv(input.argv ?? process.argv);
	const logPath = detachedLogPath(root);
	mkdirSync(logsRoot(root), { recursive: true });
	// A previous run's report would explain this run's failure.
	rmSync(detachedReportPath(root), { force: true });
	const out = openSync(logPath, "w");
	// Its own scope on Linux: the run outlives a restart of the service that
	// started it. The pid stays the run's own, which the wait below matches.
	const child = Bun.spawn(inOwnUserScope(argv, `buncargo dev ${root}`), {
		cwd: process.cwd(),
		stdio: ["ignore", out, out],
		detached: true,
		env: {
			...process.env,
			[DETACHED_ENV]: detachedRunEnv(input.keep ? "keep" : "idle-limit"),
		},
	});
	closeSync(out);
	child.unref();

	let exited: number | undefined;
	void child.exited.then((code) => {
		exited = code;
	});

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		// First: an entry can outlive its run, released for the idle hold.
		if (exited !== undefined) {
			const output = tail(logPath);
			if (exited === 0) {
				if (output) log.line(output);
				log.success("The run had nothing to keep running in the background.");
				return 0;
			}
			// The cause last, where `| tail` reads it.
			const failure = readDetachedReport(root)?.failures.at(-1);
			if (!failure) {
				if (output) log.line(output);
				log.errorNow(
					`The run exited with code ${exited} before its apps came up.`,
					[`Full output: ${logPath}`],
				);
				return 1;
			}
			log.line(
				`  The run exited with code ${exited} before its apps came up. Full output: ${logPath}`,
			);
			printFailure(failure);
			return 1;
		}
		const run = (await findRunsByRoot(root).catch(() => [])).find(
			(entry) => entry.pid === child.pid,
		);
		if (run && settledRun(run, expectApps)) {
			const down = run.apps.filter(
				(app) => app.status === "failed" || app.status === "stopped",
			);
			for (const app of run.apps) log.line(`  ${describeApp(app)}`);
			log.line(`  pid ${child.pid} · output: ${logPath}`);
			for (const warning of namedHostsFallbacks(readLog(logPath)))
				log.warn(warning);
			if (down.length === 0) {
				log.success(
					// What the run recorded: Tailscale mode records no limit, whatever
					// `--keep` said.
					run.idleLimitMs === undefined
						? "Running in the background until you stop it with `buncargo stop`."
						: `Running in the background; it stops after ${formatDuration(run.idleLimitMs)} with no request or buncargo command (\`dev --detach --keep\` keeps it). Stop it now with \`buncargo stop\`.`,
				);
				return 0;
			}
			log.line(
				`  ${down.map((app) => app.name).join(", ")} did not come up; the other apps keep running.`,
			);
			const report = readDetachedReport(root);
			for (const app of down)
				printFailure(
					report?.failures.find((failure) => failure.step === app.name) ??
						describeAppFailure({
							app: app.name,
							reason: app.status,
							tail: [],
							setupHints: report?.setupHints ?? [],
						}),
				);
			return 1;
		}
		if (Date.now() >= deadline) {
			log.error(
				`Apps still starting after ${Math.round(timeoutMs / 1000)}s; the run keeps going (pid ${child.pid}).`,
			);
			log.hint(`Follow it: buncargo logs -f · output: ${logPath}`);
			return 1;
		}
		await promiseTimeout(POLL_MS);
	}
}
