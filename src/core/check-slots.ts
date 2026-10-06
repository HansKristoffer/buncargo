import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { checkSlotCount, isCI } from "./runtime-flags";
import { getStateDir } from "./state-paths";

/**
 * A machine-wide cap on heavy checks (typechecks, test suites) across every
 * checkout.
 *
 * Coding agents run checks in many worktrees at once, and one native `tsc`
 * peaks at several GB. Unbounded, they run the machine out of memory and slow
 * each other down. Each slot is a lock file under `~/.buncargo/check-slots/`.
 * The holder's pid in it lets a lock left behind by a killed process be
 * reclaimed.
 *
 * The holder exports `BUNCARGO_CHECK_SLOT` to its children, so a command that
 * already holds a slot (`exec --slot -- bun run lint`) never waits on itself
 * when it reaches `buncargo typecheck`.
 */

export const CHECK_SLOT_ENV = "BUNCARGO_CHECK_SLOT";
const SLOT_DIRNAME = "check-slots";
// A holder writes its lock within milliseconds of creating it. An unreadable
// lock older than this was left half-written (a full disk, a kill mid-write).
const UNREADABLE_LOCK_GRACE_MS = 5_000;

export interface CheckSlotHolder {
	pid: number;
	cwd: string;
	label: string;
	startedAt: number;
}

export interface CheckSlotOptions {
	/** Defaults to `BUNCARGO_CHECK_SLOTS`, else 3. 0 disables the cap. */
	slots?: number;
	dir?: string;
	env?: NodeJS.ProcessEnv;
	pollMs?: number;
	/** Called once when every slot is taken, before waiting. */
	onWait?: (holders: CheckSlotHolder[]) => void;
}

function readHolder(file: string): CheckSlotHolder | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as CheckSlotHolder;
	} catch {
		return undefined;
	}
}

function holderAlive(file: string): boolean {
	const holder = readHolder(file);
	if (!holder) {
		try {
			return Date.now() - statSync(file).mtimeMs < UNREADABLE_LOCK_GRACE_MS;
		} catch {
			return false;
		}
	}
	try {
		process.kill(holder.pid, 0);
		return true;
	} catch (error) {
		// EPERM is a live process owned by someone else.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function tryAcquire(
	dir: string,
	slots: number,
	holder: CheckSlotHolder,
): string | undefined {
	for (let slot = 0; slot < slots; slot++) {
		const file = join(dir, `${slot}.lock`);
		let fd: number;
		try {
			fd = openSync(file, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A racing reclaimer can remove a lock that was just re-taken and let
			// one extra check through. For a memory cap that is acceptable.
			if (!holderAlive(file)) {
				try {
					unlinkSync(file);
				} catch {}
			}
			continue;
		}

		try {
			writeSync(fd, JSON.stringify(holder));
			return file;
		} catch (error) {
			// An empty lock would read as held: never leave one behind.
			unlinkSync(file);
			throw error;
		} finally {
			closeSync(fd);
		}
	}
	return undefined;
}

/** The current holders, for the waiting message and `doctor`-style output. */
export function checkSlotHolders(
	dir = join(getStateDir(), SLOT_DIRNAME),
	slots = checkSlotCount(),
): CheckSlotHolder[] {
	const holders: CheckSlotHolder[] = [];
	for (let slot = 0; slot < slots; slot++) {
		const holder = readHolder(join(dir, `${slot}.lock`));
		if (holder) holders.push(holder);
	}
	return holders;
}

export function formatCheckSlotHolder(holder: CheckSlotHolder): string {
	const seconds = Math.round((Date.now() - holder.startedAt) / 1000);
	return `${basename(holder.cwd)} ${holder.label} (${seconds}s)`;
}

/**
 * Run `run` while holding a check slot, waiting for one when all are taken.
 * Skipped in CI, when the cap is 0, and inside a process that already holds a
 * slot.
 */
export async function withCheckSlot<T>(
	label: string,
	run: () => Promise<T>,
	options: CheckSlotOptions = {},
): Promise<T> {
	const env = options.env ?? process.env;
	const slots = options.slots ?? checkSlotCount(env);
	if (isCI(env) || slots === 0 || env[CHECK_SLOT_ENV]) return run();

	const dir = options.dir ?? join(getStateDir(), SLOT_DIRNAME);
	const holder: CheckSlotHolder = {
		pid: process.pid,
		cwd: process.cwd(),
		label,
		startedAt: Date.now(),
	};

	// The cap protects memory; it must never be why a check cannot run. A
	// full disk or an unwritable state directory runs the check without one.
	let file: string | undefined;
	try {
		mkdirSync(dir, { recursive: true });
		file = tryAcquire(dir, slots, holder);
		if (!file) {
			options.onWait?.(checkSlotHolders(dir, slots));
			while (!file) {
				await Bun.sleep(options.pollMs ?? 500);
				file = tryAcquire(dir, slots, holder);
			}
		}
	} catch (error) {
		console.warn(
			`Running without a check slot: ${error instanceof Error ? error.message : String(error)}`,
		);
		return run();
	}

	const held = file;
	const release = () => {
		if (readHolder(held)?.pid !== process.pid) return;
		try {
			unlinkSync(held);
		} catch {}
	};
	process.once("exit", release);
	env[CHECK_SLOT_ENV] = held;

	try {
		return await run();
	} finally {
		delete env[CHECK_SLOT_ENV];
		process.off("exit", release);
		release();
	}
}
