import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { getProjectStateDir } from "../state-paths";

/**
 * Every app's output as plain text, per run: `.buncargo/logs/<run>/<app>.log`.
 *
 * What is left when the terminal has scrolled or the run has ended, and what
 * an agent reads (`buncargo logs shopify --errors`). Written in both output
 * modes, already stripped of escapes, and capped per file.
 */

/** Runs kept per checkout; older directories are removed when a run starts. */
const KEPT_RUNS = 10;
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

function runDirName(sessionId: string, now: Date): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
	return `${stamp}-${sessionId.slice(0, 8)}`;
}

export class AppLogs {
	readonly dir: string;
	private pending = new Map<string, string[]>();
	private sizes = new Map<string, number>();
	private timer?: ReturnType<typeof setTimeout>;

	constructor(root: string, sessionId: string, now = new Date()) {
		this.dir = join(logsRoot(root), runDirName(sessionId, now));
		mkdirSync(this.dir, { recursive: true });
		for (const old of listRunLogDirs(root).slice(0, -KEPT_RUNS))
			rmSync(old, { recursive: true, force: true });
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
