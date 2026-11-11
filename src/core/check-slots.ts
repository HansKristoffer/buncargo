import {
	closeSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getErrorMessage } from "hanzio";
import { tryLockDescriptor } from "./file-lock";
import {
	CHECK_SLOT_ENV,
	checkSlotCount,
	heldCheckSlot,
	isCI,
} from "./runtime-flags";
import { getStateDir } from "./state-paths";

/**
 * A machine-wide cap on heavy checks (typechecks, test suites) across every
 * checkout.
 *
 * Coding agents run checks in many worktrees at once, and one native `tsc`
 * peaks at several GB. Unbounded, they run the machine out of memory and slow
 * each other down. Each slot is a file under `~/.buncargo/check-slots/` whose
 * kernel lock (`flock`) its holder keeps for the length of the check. The
 * kernel frees the lock when the holder exits, however it dies, so no pid is
 * ever judged. The holder's details in the file are only for the waiting
 * message.
 *
 * The holder exports `BUNCARGO_CHECK_SLOT` to its children, so a command that
 * already holds a slot (`slot -- bun run lint`) never waits on itself
 * when it reaches `buncargo typecheck`.
 */

const SLOT_DIRNAME = "check-slots";
/**
 * How long a check waits for a slot before it runs without one. Long enough
 * for a queue of typechecks to drain; a holder that hangs for longer must not
 * hang every check on the machine behind it.
 */
const CHECK_SLOT_WAIT_MS = 15 * 60_000;

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
	/** How long to wait for a slot before running without one. */
	waitMs?: number;
	/** Called once when every slot is taken, before waiting. */
	onWait?: (holders: CheckSlotHolder[]) => void;
}

interface HeldSlot {
	file: string;
	fd: number;
}

function readHolder(file: string): CheckSlotHolder | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as CheckSlotHolder;
	} catch {
		return undefined;
	}
}

/**
 * Whether `fd` is still the file at `file`. A holder unlinks its file as it
 * releases, so a waiter that opened the file just before can lock the
 * unlinked inode while a third process creates and locks a new one: only the
 * one whose inode is still at the path holds the slot.
 */
function stillAtPath(fd: number, file: string): boolean {
	try {
		return fstatSync(fd).ino === statSync(file).ino;
	} catch {
		return false;
	}
}

function tryAcquire(
	dir: string,
	slots: number,
	holder: CheckSlotHolder,
): HeldSlot | undefined {
	for (let slot = 0; slot < slots; slot++) {
		const file = join(dir, `${slot}.lock`);
		const fd = openSync(file, "a+", 0o600);
		if (!tryLockDescriptor(fd) || !stillAtPath(fd, file)) {
			closeSync(fd);
			continue;
		}

		try {
			ftruncateSync(fd, 0);
			writeSync(fd, JSON.stringify(holder));
			return { file, fd };
		} catch (error) {
			release({ file, fd });
			throw error;
		}
	}
	return undefined;
}

/** Unlink before closing: the path never names a file nobody holds. */
function release(slot: HeldSlot): void {
	try {
		unlinkSync(slot.file);
	} catch {}
	try {
		closeSync(slot.fd);
	} catch {}
}

/**
 * The holders recorded in the slot files, for the waiting message. Current
 * while every slot is taken: each holder rewrote its file when it took it.
 */
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
 * Wait for a slot until the deadline. The cap protects memory; it must never
 * be why a check cannot run. A full disk, an unwritable state directory or a
 * wait past its deadline returns no slot, and the check runs without one.
 */
async function acquireSlot(
	dir: string,
	slots: number,
	holder: CheckSlotHolder,
	options: CheckSlotOptions,
): Promise<HeldSlot | undefined> {
	const waitMs = options.waitMs ?? CHECK_SLOT_WAIT_MS;
	const pollMs = options.pollMs ?? 500;
	try {
		mkdirSync(dir, { recursive: true });
		let slot = tryAcquire(dir, slots, holder);
		if (slot) return slot;

		options.onWait?.(checkSlotHolders(dir, slots));
		const deadline = Date.now() + waitMs;
		while (!slot && Date.now() < deadline) {
			await Bun.sleep(Math.min(pollMs, deadline - Date.now()));
			slot = tryAcquire(dir, slots, holder);
		}
		if (slot) return slot;

		const holders = checkSlotHolders(dir, slots).map(formatCheckSlotHolder);
		const minutes = Math.round(waitMs / 60_000);
		console.warn(
			`Waited ${minutes}m for a check slot in ${dir}, held by ${holders.join(", ")}; running without one.`,
		);
	} catch (error) {
		console.warn(`Running without a check slot: ${getErrorMessage(error)}`);
	}
	return undefined;
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
	if (isCI(env) || slots === 0 || heldCheckSlot(env)) return run();

	const dir = options.dir ?? join(getStateDir(), SLOT_DIRNAME);
	const holder: CheckSlotHolder = {
		pid: process.pid,
		cwd: process.cwd(),
		label,
		startedAt: Date.now(),
	};

	const held = await acquireSlot(dir, slots, holder, options);
	if (!held) return run();

	const releaseHeld = () => release(held);
	process.once("exit", releaseHeld);
	env[CHECK_SLOT_ENV] = held.file;

	try {
		return await run();
	} finally {
		delete env[CHECK_SLOT_ENV];
		process.off("exit", releaseHeld);
		releaseHeld();
	}
}
