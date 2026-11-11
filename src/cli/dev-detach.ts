import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promiseTimeout } from "hanzio";
import { logsRoot } from "../core/process/app-logs";
import { isProcessAlive } from "../core/process/lifecycle";
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
import { DETACH_ONLY_FLAGS } from "./dev-flags";
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

/**
 * Where a detached run's own output goes, one log per run by its pid; app
 * output is in its run directory. A shared `detached.log` rotated aside lost
 * a live run's log: the second rotation renamed over the file the first run
 * still wrote.
 */
export function detachedLogPath(root: string, pid: number): string {
	return join(logsRoot(root), `detached-${pid}.log`);
}

/** A link to the newest run's log, the one path docs and agents can name. */
function newestDetachedLogPath(root: string): string {
	return join(logsRoot(root), "detached.log");
}

/**
 * Point `detached.log` at `logPath`, replacing the link (or an earlier
 * version's file) in one rename. Only a convenience: the parent reads the
 * run's own log.
 */
function linkNewestDetachedLog(root: string, logPath: string): void {
	const link = newestDetachedLogPath(root);
	const staging = `${link}.${process.pid}.tmp`;
	try {
		rmSync(staging, { force: true });
		symlinkSync(basename(logPath), staging);
		renameSync(staging, link);
	} catch {
		rmSync(staging, { force: true });
	}
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

/**
 * One per background run, by its pid: a second `dev --detach` in the same
 * checkout must neither delete nor overwrite the report the first run is
 * still writing.
 */
export function detachedReportPath(root: string, pid: number): string {
	return join(logsRoot(root), `detached-report-${pid}.json`);
}

const REPORT_FILE = /^detached-report-(\d+)\.json$/;
const LOG_FILE = /^detached-(\d+)\.log$/;

/**
 * How long a run's report and log outlive the run: its parent polls every
 * {@link POLL_MS} and reads both only after the run has exited.
 */
const DETACHED_FILE_GRACE_MS = 60_000;

function modifiedAt(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function runPid(name: string): number | undefined {
	const pid = Number((REPORT_FILE.exec(name) ?? LOG_FILE.exec(name))?.[1]);
	return pid > 0 ? pid : undefined;
}

/**
 * Drop the reports and logs of runs that exited over a minute ago (`now`):
 * their parents have read them. The newest ended run's log stays, for a look
 * at why the run before this one ended. A pid that is alive keeps its files,
 * even when it is reused.
 */
export function pruneDetachedFiles(root: string, now: number): void {
	let names: string[] = [];
	try {
		names = readdirSync(logsRoot(root));
	} catch {
		return;
	}
	const ended = names.flatMap((name) => {
		const pid = runPid(name);
		const candidate = pid !== undefined && !isProcessAlive(pid);
		const path = join(logsRoot(root), name);
		const modified = candidate ? modifiedAt(path) : undefined;
		return modified === undefined ? [] : [{ name, path, modified }];
	});
	const previousLog = ended
		.filter((file) => LOG_FILE.test(file.name))
		.sort((a, b) => b.modified - a.modified)[0];
	for (const file of ended) {
		const recent = now - file.modified < DETACHED_FILE_GRACE_MS;
		if (recent || file === previousLog) continue;
		rmSync(file.path, { force: true });
	}
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

export function readDetachedReport(
	root: string,
	pid: number,
): DetachedReport | undefined {
	return readJsonDocumentSync(detachedReportPath(root, pid), validateReport);
}

/**
 * Update this process's report as the detached run in `root`. Synchronous,
 * so it is on disk before the registry says the app failed, which is what
 * the parent waits for. No lock: the run itself is the one writer, on one
 * thread. A report that cannot be written loses only the explanation.
 */
export function recordDetachedReport(
	root: string,
	update: (report: DetachedReport) => DetachedReport,
): void {
	const current = readDetachedReport(root, process.pid) ?? {
		setupHints: [],
		failures: [],
	};
	try {
		writeJsonDocumentSync(
			detachedReportPath(root, process.pid),
			update(current),
		);
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
 * Argv for the background run: this same invocation without the flags only
 * `dev --detach` reads ({@link DETACH_ONLY_FLAGS}), so a script wrapping
 * `runCli` is re-run the same way `buncargo dev` is. Args after `--` are the
 * attached app's and pass through untouched.
 */
export function detachedArgv(
	argv: readonly string[],
	execPath = process.execPath,
): string[] {
	const args = argv.slice(1);
	const separator = args.indexOf("--");
	const flagsEnd = separator === -1 ? args.length : separator;
	const detachOnly = new Set(DETACH_ONLY_FLAGS.map((flag) => flag.name));
	return [
		execPath,
		...args.slice(0, flagsEnd).filter((arg) => !detachOnly.has(arg)),
		...args.slice(flagsEnd),
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

/**
 * How long a settled run's down apps get for their failure reports. An app
 * that crashed while it started reaches the registry as `failed` with its
 * exit, before the supervisor has parked it and reported why: settling on
 * that printed a generic failure with no output. An app that stopped on its
 * own (an `essential: false` one that exited) never gets a report, so the
 * wait ends.
 */
export const REPORT_GRACE_MS = 2_000;

/** The down apps of a settled run whose failure is not in the report yet. */
export function unreportedApps(
	down: readonly RunAppEntry[],
	report: DetachedReport | undefined,
): string[] {
	return down
		.filter(
			(app) => !report?.failures.some((failure) => failure.step === app.name),
		)
		.map((app) => app.name);
}

/**
 * `dev --detach`'s exit codes: 0 every app up, 1 the run failed or an app did
 * not come up, 2 still starting at the timeout (the run keeps going), as
 * `buncargo wait` exits.
 */
export const DETACH_EXIT = { ok: 0, failed: 1, timeout: 2 } as const;

/** How long `dev --detach` waits for apps to settle before exiting 2. */
export const DETACH_TIMEOUT_MS = 10 * 60_000;

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
 * failed or an app did not come up (the others keep running); 2 when apps are
 * still starting at the timeout ({@link DETACH_EXIT}).
 */
export async function runDetached(input: {
	root: string;
	/** Whether the selection has apps to spawn and wait for (see {@link settledRun}). */
	expectApps: boolean;
	/** `--keep`: no idle limit. */
	keep: boolean;
	/** The `dev --detach` invocation, re-run without the flag ({@link detachedArgv}). */
	argv: readonly string[];
	/** How long apps may take to settle before this exits 2. */
	timeoutMs: number;
}): Promise<number> {
	const { root, expectApps, timeoutMs } = input;
	const argv = detachedArgv(input.argv);
	mkdirSync(logsRoot(root), { recursive: true });
	pruneDetachedFiles(root, Date.now());
	// Named by this process until the run has a pid; the rename after the
	// spawn leaves the run's descriptor writing the same file.
	const startingPath = join(
		logsRoot(root),
		`detached-starting-${process.pid}.log`,
	);
	const out = openSync(startingPath, "w");
	let child: Bun.Subprocess;
	try {
		// Its own scope on Linux: the run outlives a restart of the service
		// that started it. The pid stays the run's own, which the wait below
		// matches.
		child = Bun.spawn(inOwnUserScope(argv, `buncargo dev ${root}`), {
			cwd: process.cwd(),
			stdio: ["ignore", out, out],
			detached: true,
			env: {
				...process.env,
				[DETACHED_ENV]: detachedRunEnv(input.keep ? "keep" : "idle-limit"),
			},
		});
	} catch (error) {
		rmSync(startingPath, { force: true });
		throw error;
	} finally {
		closeSync(out);
	}
	child.unref();
	const logPath = detachedLogPath(root, child.pid);
	renameSync(startingPath, logPath);
	linkNewestDetachedLog(root, logPath);
	// A report left by an earlier process with this pid would explain this
	// run's failure. Removed before the run has loaded anything to report.
	rmSync(detachedReportPath(root, child.pid), { force: true });

	let exited: number | undefined;
	let settledAt: number | undefined;
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
				return DETACH_EXIT.ok;
			}
			// The cause last, where `| tail` reads it.
			const failure = readDetachedReport(root, child.pid)?.failures.at(-1);
			if (!failure) {
				if (output) log.line(output);
				log.errorNow(
					`The run exited with code ${exited} before its apps came up.`,
					[`Full output: ${logPath}`],
				);
				return DETACH_EXIT.failed;
			}
			log.line(
				`  The run exited with code ${exited} before its apps came up. Full output: ${logPath}`,
			);
			printFailure(failure);
			return DETACH_EXIT.failed;
		}
		const run = (await findRunsByRoot(root).catch(() => [])).find(
			(entry) => entry.pid === child.pid,
		);
		const settled = run !== undefined && settledRun(run, expectApps);
		const down = (run?.apps ?? []).filter(
			(app) => app.status === "failed" || app.status === "stopped",
		);
		const report = readDetachedReport(root, child.pid);
		if (settled) settledAt ??= Date.now();
		else settledAt = undefined;
		const awaitingReport =
			settledAt !== undefined &&
			unreportedApps(down, report).length > 0 &&
			Date.now() - settledAt < REPORT_GRACE_MS;
		if (run && settled && !awaitingReport) {
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
				return DETACH_EXIT.ok;
			}
			log.line(
				`  ${down.map((app) => app.name).join(", ")} did not come up; the other apps keep running.`,
			);
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
			return DETACH_EXIT.failed;
		}
		if (Date.now() >= deadline) {
			log.error(
				`Apps still starting after ${Math.round(timeoutMs / 1000)}s; the run keeps going (pid ${child.pid}).`,
			);
			log.hint(`Follow it: buncargo logs -f · output: ${logPath}`);
			return DETACH_EXIT.timeout;
		}
		await promiseTimeout(POLL_MS);
	}
}
