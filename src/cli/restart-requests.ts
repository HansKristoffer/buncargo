import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { getProjectStateDir } from "../core/state-paths";

/**
 * `buncargo restart <app>` asks a running `dev` to restart one of its apps.
 *
 * A request is a line in `.buncargo/restart/<session>` that the run polls.
 * Not a signal: SIGUSR2 to a run from an older buncargo, which has no
 * handler, would kill it.
 */

const POLL_MS = 500;

function requestFile(root: string, sessionId: string): string {
	return join(getProjectStateDir(root), "restart", sessionId);
}

export function requestRestart(
	root: string,
	sessionId: string,
	app: string,
): void {
	const file = requestFile(root, sessionId);
	mkdirSync(join(file, ".."), { recursive: true });
	appendFileSync(file, `${app}\n`);
}

/** Restart each requested app as it is asked for, until the returned stop. */
export function watchRestartRequests(
	root: string,
	sessionId: string,
	restart: (app: string) => void,
): () => void {
	const file = requestFile(root, sessionId);
	const taken = `${file}.taken`;
	const timer = setInterval(() => {
		if (!existsSync(file)) return;
		let names: string[] = [];
		try {
			// Moved aside before it is read: a request appended meanwhile lands
			// in a new file for the next poll instead of being deleted unread.
			renameSync(file, taken);
			names = readFileSync(taken, "utf8").split("\n").filter(Boolean);
			rmSync(taken, { force: true });
		} catch {
			return;
		}
		for (const name of new Set(names)) restart(name);
	}, POLL_MS);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		rmSync(file, { force: true });
	};
}
