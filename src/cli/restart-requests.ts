import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sleep } from "../core/sleep";
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

/** Ask the run to type `text` into `app`; the id its answer is filed under. */
export function requestSend(
	root: string,
	sessionId: string,
	app: string,
	text: string,
): string {
	const id = randomUUID();
	appendRequest(root, sessionId, "send", JSON.stringify({ id, app, text }));
	return id;
}

/**
 * The run's answer to one send: typed, or why not. `send` waits for it, so a
 * key that reached no app is an exit code rather than a line in the run's log.
 */
export type SendReply =
	| { delivered: true }
	| { delivered: false; reason: string };

const SEND_ID = /^[\w-]+$/;

function repliesDir(root: string, sessionId: string): string {
	return `${requestFile(root, sessionId, "send")}.replies`;
}

function writeSendReply(
	root: string,
	sessionId: string,
	id: string,
	reply: SendReply,
): void {
	// A request line is not trusted to name a path.
	if (!SEND_ID.test(id)) return;
	const dir = repliesDir(root, sessionId);
	const path = join(dir, id);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${path}.tmp`, JSON.stringify(reply));
		renameSync(`${path}.tmp`, path);
	} catch {
		// The keys were handled; only the answer is lost, and `send` says so.
	}
}

/**
 * Type each requested text into its app, in order, until the returned stop.
 * `send` returns why it could not, or `undefined` once it typed it.
 */
export function watchSendRequests(
	root: string,
	sessionId: string,
	send: (app: string, text: string) => string | undefined,
): () => void {
	const stop = watchRequests(root, sessionId, "send", (lines) => {
		for (const line of lines) {
			try {
				const { id, app, text } = JSON.parse(line) as {
					id?: unknown;
					app: string;
					text: string;
				};
				if (typeof app !== "string" || typeof text !== "string") continue;
				const refusal = send(app, text);
				if (typeof id === "string")
					writeSendReply(
						root,
						sessionId,
						id,
						refusal === undefined
							? { delivered: true }
							: { delivered: false, reason: refusal },
					);
			} catch {
				// A torn line: the request is lost, not the run.
			}
		}
	});
	return () => {
		stop();
		rmSync(repliesDir(root, sessionId), { recursive: true, force: true });
	};
}

/** The run's answer to request `id`, or `undefined` when none came in time. */
export async function awaitSendReply(
	root: string,
	sessionId: string,
	id: string,
	timeoutMs: number,
): Promise<SendReply | undefined> {
	const path = join(repliesDir(root, sessionId), id);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const reply = JSON.parse(readFileSync(path, "utf8")) as SendReply;
			rmSync(path, { force: true });
			return reply;
		} catch {
			// Not answered yet.
		}
		if (Date.now() >= deadline) return undefined;
		await sleep(50);
	}
}
