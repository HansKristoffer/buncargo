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
 * Asking a running `dev` to act on one of its apps from outside it:
 * `buncargo restart <app>` and `buncargo send <app> <keys>`.
 *
 * A request is a line in `.buncargo/<kind>/<session>` that the run polls.
 * Not a signal: SIGUSR2 to a run from an older buncargo, which has no
 * handler, would kill it.
 */

const POLL_MS = 500;

type RequestKind = "restart" | "send";

function requestFile(root: string, sessionId: string, kind: RequestKind) {
	return join(getProjectStateDir(root), kind, sessionId);
}

function appendRequest(
	root: string,
	sessionId: string,
	kind: RequestKind,
	line: string,
): void {
	const file = requestFile(root, sessionId, kind);
	mkdirSync(join(file, ".."), { recursive: true });
	appendFileSync(file, `${line}\n`);
}

/** Hand each batch of requests to `handle` as it arrives, until the returned stop. */
function watchRequests(
	root: string,
	sessionId: string,
	kind: RequestKind,
	handle: (lines: string[]) => void,
): () => void {
	const file = requestFile(root, sessionId, kind);
	const taken = `${file}.taken`;
	const timer = setInterval(() => {
		if (!existsSync(file)) return;
		let lines: string[] = [];
		try {
			// Moved aside before it is read: a request appended meanwhile lands
			// in a new file for the next poll instead of being deleted unread.
			renameSync(file, taken);
			lines = readFileSync(taken, "utf8").split("\n").filter(Boolean);
			rmSync(taken, { force: true });
		} catch {
			return;
		}
		handle(lines);
	}, POLL_MS);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		rmSync(file, { force: true });
	};
}

export function requestRestart(
	root: string,
	sessionId: string,
	app: string,
): void {
	appendRequest(root, sessionId, "restart", app);
}

/** Restart each requested app as it is asked for, until the returned stop. */
export function watchRestartRequests(
	root: string,
	sessionId: string,
	restart: (app: string) => void,
): () => void {
	return watchRequests(root, sessionId, "restart", (names) => {
		for (const name of new Set(names)) restart(name);
	});
}

export function requestSend(
	root: string,
	sessionId: string,
	app: string,
	text: string,
): void {
	appendRequest(root, sessionId, "send", JSON.stringify({ app, text }));
}

/** Type each requested text into its app, in order, until the returned stop. */
export function watchSendRequests(
	root: string,
	sessionId: string,
	send: (app: string, text: string) => void,
): () => void {
	return watchRequests(root, sessionId, "send", (lines) => {
		for (const line of lines) {
			try {
				const { app, text } = JSON.parse(line) as { app: string; text: string };
				if (typeof app === "string" && typeof text === "string")
					send(app, text);
			} catch {
				// A torn line: the request is lost, not the run.
			}
		}
	});
}
