import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getProjectStateDir } from "../state-paths";
import { isProcessAlive } from "./lifecycle";

/**
 * Every app's output as plain text, per run: `.buncargo/logs/<run>/<app>.log`.
 *
 * What is left when the terminal has scrolled or the run has ended, and what
 * an agent reads (`buncargo logs shopify --errors`). Written in both output
 * modes, already stripped of escapes, and capped per file.
 */

/**
 * Runs kept per checkout; older directories are removed when a run starts,
 * unless their run is still going.
 */
const KEPT_RUNS = 10;
/** The pid of the run writing a directory, so pruning can tell it is live. */
const OWNER_FILE = "owner.pid";
/** Past this a file rotates to `<app>.log.1`, replacing the previous one. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FLUSH_MS = 200;

export function logsRoot(root: string): string {
	return join(getProjectStateDir(root), "logs");
}

/** Run directories, oldest first: names start with their start time. */
export function listRunLogDirs(root: string): string[] {
	const dir = logsRoot(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(dir, entry.name))
		.sort();
}

/** What a run directory's name ends with for its session. */
function sessionTag(sessionId: string): string {
	return sessionId.slice(0, 8);
}

function runDirName(sessionId: string, now: Date): string {
	// Milliseconds kept: two runs in one second must still sort by start.
	const stamp = now.toISOString().replace(/[-:.]/g, "");
	return `${stamp}-${sessionTag(sessionId)}`;
}

/** Whether `dir` is a directory of the run with this session id. */
export function isSessionLogDir(dir: string, sessionId: string): boolean {
	return basename(dir).endsWith(`-${sessionTag(sessionId)}`);
}

function ownerAlive(dir: string): boolean {
	try {
		const pid = Number(readFileSync(join(dir, OWNER_FILE), "utf8"));
		return pid > 0 && isProcessAlive(pid);
	} catch {
		return false;
	}
}

export class AppLogs {
	readonly dir: string;
	private pending = new Map<string, string[]>();
	private sizes = new Map<string, number>();
	private timer?: ReturnType<typeof setTimeout>;

	constructor(root: string, sessionId: string, now = new Date()) {
		this.dir = join(logsRoot(root), runDirName(sessionId, now));
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, OWNER_FILE), String(process.pid));
		// A live run's directory stays: its next flush would fail silently.
		for (const old of listRunLogDirs(root).slice(0, -KEPT_RUNS))
			if (!ownerAlive(old)) rmSync(old, { recursive: true, force: true });
	}

	file(app: string): string {
		return join(this.dir, `${app}.log`);
	}

	/** One plain line. Buffered briefly: a chatty app should not cost a write per line. */
	write(app: string, text: string, time = new Date()): void {
		const lines = this.pending.get(app) ?? [];
		lines.push(`${time.toISOString()} ${text}\n`);
		this.pending.set(app, lines);
		this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
		this.timer.unref?.();
	}

	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		for (const [app, lines] of this.pending) {
			const file = this.file(app);
			const text = lines.join("");
			try {
				const size =
					this.sizes.get(app) ?? (existsSync(file) ? statSync(file).size : 0);
				if (size + text.length > MAX_FILE_BYTES && size > 0) {
					renameSync(file, `${file}.1`);
					this.sizes.set(app, 0);
				}
				appendFileSync(file, text);
				this.sizes.set(app, (this.sizes.get(app) ?? 0) + text.length);
			} catch {
				// A log that cannot be written is lost output, never a failed run.
			}
		}
		this.pending.clear();
	}
}
