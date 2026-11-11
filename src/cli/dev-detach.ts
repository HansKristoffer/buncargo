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
import { isBoolean, isRecord, isString, promiseTimeout } from "hanzio";
import { arrayOf, object, optional } from "../core/json-shape";
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
import type { DetachedResultJson } from "./json-documents";
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
	/** Why named URLs fell back to `localhost:port`, which is otherwise silent. */
	hostsWarnings: string[];
	/**
	 * Whether the run's selection has apps to spawn (see {@link settledRun}),
	 * recorded once it has planned: only the run loads the config.
	 */
	expectApps?: boolean;
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

const isRunFailure = object({
	cause: isString,
	step: optional(isString),
	output: arrayOf(isString),
	hints: arrayOf(isString),
	next: arrayOf(isString),
});

function validateReport(value: unknown): DetachedReport | undefined {
	if (
		!isRecord(value) ||
		!Array.isArray(value.setupHints) ||
		!Array.isArray(value.failures) ||
		!Array.isArray(value.hostsWarnings) ||
		!(value.expectApps === undefined || isBoolean(value.expectApps))
	)
		return undefined;
	// A malformed entry never rejected a report; it is left out of its list.
	return {
		setupHints: value.setupHints.filter(isString),
		failures: value.failures.filter(isRunFailure),
		hostsWarnings: value.hostsWarnings.filter(isString),
		...(value.expectApps !== undefined && { expectApps: value.expectApps }),
	};
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
		hostsWarnings: [],
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
	const detachOnly = new Set(DETACH_ONLY_FLAGS);
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

/** What the wait for a background run ended on. */
type DetachedOutcome = Omit<DetachedResultJson, "version" | "exitCode"> & {
	/** The run exited, with this code. */
	exited?: number;
	/** The run's last output, for a run that exited. */
	output?: string;
};

const OUTCOME_EXIT = {
	up: DETACH_EXIT.ok,
	finished: DETACH_EXIT.ok,
	failed: DETACH_EXIT.failed,
	timeout: DETACH_EXIT.timeout,
} as const satisfies Record<DetachedResultJson["outcome"], number>;

/**
 * Start the run in the background and wait for it. 0 when every app came up,
 * or when the run finished cleanly with nothing left to run (every selected
 * app already running elsewhere, as attached `dev` exits 0 on); 1 when the run
 * failed or an app did not come up (the others keep running); 2 when apps are
 * still starting at the timeout ({@link DETACH_EXIT}). `json` prints the
 * outcome as one {@link DetachedResultJson} instead of prose.
 */
export async function runDetached(input: {
	root: string;
	/** `--keep`: no idle limit. */
	keep: boolean;
	json: boolean;
	/** The `dev --detach` invocation, re-run without the flag ({@link detachedArgv}). */
	argv: readonly string[];
	/** How long apps may take to settle before this exits 2. */
	timeoutMs: number;
}): Promise<number> {
	const outcome = await startAndWait(input);
	const exitCode = OUTCOME_EXIT[outcome.outcome];
	if (input.json) {
		const { exited: _, output: __, ...result } = outcome;
		log.line(
			JSON.stringify(
				{ version: 1, exitCode, ...result } satisfies DetachedResultJson,
				null,
				2,
			),
		);
	} else printOutcome(outcome, input.timeoutMs);
	return exitCode;
}

async function startAndWait(input: {
	root: string;
	keep: boolean;
	argv: readonly string[];
	timeoutMs: number;
}): Promise<DetachedOutcome> {
	const { root, timeoutMs } = input;
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
	const base = {
		pid: child.pid,
		log: logPath,
		apps: [] as DetachedResultJson["apps"],
		idleLimitMs: null,
	};

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		// First: an entry can outlive its run, released for the idle hold.
		if (exited !== undefined) {
			const report = readDetachedReport(root, child.pid);
			// The cause last, where `| tail` reads it.
			const failure = report?.failures.at(-1);
			return {
				...base,
				outcome: exited === 0 ? "finished" : "failed",
				hostsWarnings: report?.hostsWarnings ?? [],
				failures: exited === 0 || !failure ? [] : [failure],
				exited,
				output: tail(logPath),
			};
		}
		const run = (await findRunsByRoot(root).catch(() => [])).find(
			(entry) => entry.pid === child.pid,
		);
		const report = readDetachedReport(root, child.pid);
		const expectApps = report?.expectApps;
		const settled =
			run !== undefined &&
			expectApps !== undefined &&
			settledRun(run, expectApps);
		const down = (run?.apps ?? []).filter(
			(app) => app.status === "failed" || app.status === "stopped",
		);
		if (settled) settledAt ??= Date.now();
		else settledAt = undefined;
		const awaitingReport =
			settledAt !== undefined &&
			unreportedApps(down, report).length > 0 &&
			Date.now() - settledAt < REPORT_GRACE_MS;
		const apps = (run?.apps ?? []).map((app) => ({
			name: app.name,
			status: app.status,
			url: app.openUrl ?? null,
		}));
		if (run && settled && !awaitingReport)
			return {
				...base,
				apps,
				// What the run recorded: Tailscale mode records no limit, whatever
				// `--keep` said.
				idleLimitMs: run.idleLimitMs ?? null,
				outcome: down.length === 0 ? "up" : "failed",
				hostsWarnings: report?.hostsWarnings ?? [],
				failures: down.map(
					(app) =>
						report?.failures.find((failure) => failure.step === app.name) ??
						describeAppFailure({
							app: app.name,
							reason: app.status,
							tail: [],
							setupHints: report?.setupHints ?? [],
						}),
				),
			};
		if (Date.now() >= deadline)
			return {
				...base,
				apps,
				outcome: "timeout",
				hostsWarnings: report?.hostsWarnings ?? [],
				failures: [],
			};
		await promiseTimeout(POLL_MS);
	}
}

/** Print a failure block, past Bun's buffer: the parent exits right after. */
function printFailure(failure: RunFailure): void {
	const { message, hints } = formatRunFailure(failure);
	log.errorNow(message, hints);
}

function printOutcome(outcome: DetachedOutcome, timeoutMs: number): void {
	const { pid, log: logPath } = outcome;
	if (outcome.exited !== undefined) {
		if (outcome.output && !outcome.failures.length) log.line(outcome.output);
		if (outcome.outcome === "finished") {
			log.success("The run had nothing to keep running in the background.");
			return;
		}
		const [failure] = outcome.failures;
		if (!failure) {
			log.errorNow(
				`The run exited with code ${outcome.exited} before its apps came up.`,
				[`Full output: ${logPath}`],
			);
			return;
		}
		log.line(
			`  The run exited with code ${outcome.exited} before its apps came up. Full output: ${logPath}`,
		);
		printFailure(failure);
		return;
	}
	if (outcome.outcome === "timeout") {
		log.error(
			`Apps still starting after ${Math.round(timeoutMs / 1000)}s; the run keeps going (pid ${pid}).`,
		);
		log.hint(`Follow it: buncargo logs -f · output: ${logPath}`);
		return;
	}
	for (const app of outcome.apps)
		log.line(`  ${app.name}: ${app.status}${app.url ? `  ${app.url}` : ""}`);
	log.line(`  pid ${pid} · output: ${logPath}`);
	for (const warning of outcome.hostsWarnings) log.warn(warning);
	if (outcome.outcome === "up") {
		log.success(
			outcome.idleLimitMs === null
				? "Running in the background until you stop it with `buncargo stop`."
				: `Running in the background; it stops after ${formatDuration(outcome.idleLimitMs)} with no request or buncargo command (\`dev --detach --keep\` keeps it). Stop it now with \`buncargo stop\`.`,
		);
		return;
	}
	const down = outcome.apps.filter(
		(app) => app.status === "failed" || app.status === "stopped",
	);
	log.line(
		`  ${down.map((app) => app.name).join(", ")} did not come up; the other apps keep running.`,
	);
	for (const failure of outcome.failures) printFailure(failure);
}
