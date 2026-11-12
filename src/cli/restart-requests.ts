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
import { promiseTimeout } from "hanzio";
import { getProjectStateDir } from "../core/state-paths";

/**
 * Asking a running `dev` to act on one of its apps from outside it:
 * `buncargo restart <app>` and `buncargo send <app> <keys>`.
 *
 * A request is a JSON line in `.buncargo/<kind>/<session>` that the run
 * polls, with an id; the run answers it in `<session>.replies/<id>`.
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

/**
 * Hand each batch of requests to `handle` as it arrives, until the returned
 * stop. Requests wait in their file until `ready()`: one read before the run
 * can act on it would be lost.
 */
function watchRequests(
	root: string,
	sessionId: string,
	kind: RequestKind,
	handle: (lines: string[]) => void,
	ready: () => boolean,
): () => void {
	const file = requestFile(root, sessionId, kind);
	const taken = `${file}.taken`;
	const timer = setInterval(() => {
		if (!existsSync(file) || !ready()) return;
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

/** Ask the run to restart `app`; the id its answer is filed under. */
export function requestRestart(
	root: string,
	sessionId: string,
	app: string,
): string {
	const id = randomUUID();
	appendRequest(root, sessionId, "restart", JSON.stringify({ id, app }));
	return id;
}

/**
 * Whether a run took this session's restart requests within `timeoutMs`:
 * their file is gone. Only `buncargo dev` reads them, and it does from the
 * moment its first app spawns, so an app with a pid whose requests stay put
 * belongs to a run that never will (a library `start()`).
 */
export async function awaitRestartTaken(
	root: string,
	sessionId: string,
	timeoutMs: number,
): Promise<boolean> {
	const file = requestFile(root, sessionId, "restart");
	const deadline = Date.now() + timeoutMs;
	while (existsSync(file)) {
		if (Date.now() >= deadline) return false;
		await promiseTimeout(50);
	}
	return true;
}

/**
 * Take back request `id` nobody took, leaving any other request in the
 * file. Moved aside first, as the run does, so a request appended meanwhile
 * is not lost.
 */
export function withdrawRestartRequest(
	root: string,
	sessionId: string,
	id: string,
): void {
	const file = requestFile(root, sessionId, "restart");
	const aside = `${file}.withdrawn-${randomUUID()}`;
	let lines: string[];
	try {
		renameSync(file, aside);
		lines = readFileSync(aside, "utf8").split("\n").filter(Boolean);
		rmSync(aside, { force: true });
	} catch {
		// Taken after all, or already withdrawn.
		return;
	}
	const kept = lines.filter((line) => parseRequest(line)?.id !== id);
	if (kept.length > 0) appendFileSync(file, `${kept.join("\n")}\n`);
}

/**
 * The run's answer to one restart: the app's process was replaced, the
 * replacement failed, or the app is not the run's to restart (reused from
 * another terminal, or the run is ending).
 */
export type RestartReply =
	| { status: "began" }
	| { status: "failed"; reason: string }
	| { status: "not-ours"; reason: string };

/**
 * Restart each requested app as it is asked for, until the returned stop,
 * and answer each request with what came of it. Two requests for one app in
 * a batch share one restart. Requests wait until `ready()`: the run can
 * restart nothing before its apps have spawned.
 */
export function watchRestartRequests(
	root: string,
	sessionId: string,
	restart: (app: string) => Promise<RestartReply>,
	ready: () => boolean,
): () => void {
	const stop = watchRequests(
		root,
		sessionId,
		"restart",
		(lines) => {
			const requests = lines.flatMap((line) => parseRequest(line) ?? []);
			for (const [app, asked] of Map.groupBy(requests, (entry) => entry.app))
				void restart(app).then((reply) => {
					for (const { id } of asked)
						writeReply(root, sessionId, "restart", id, reply);
				});
		},
		ready,
	);
	return () => {
		stop();
		rmSync(repliesDir(root, sessionId, "restart"), {
			recursive: true,
			force: true,
		});
	};
}

function parseRequest(line: string): { id: string; app: string } | undefined {
	try {
		const { id, app } = JSON.parse(line) as { id?: unknown; app?: unknown };
		return typeof id === "string" && typeof app === "string"
			? { id, app }
			: undefined;
	} catch {
		// A torn line: the request is lost, not the run.
		return undefined;
	}
}

/** The run's answer to restart request `id`, or `undefined` when none came in time. */
export function awaitRestartReply(
	root: string,
	sessionId: string,
	id: string,
	timeoutMs: number,
): Promise<RestartReply | undefined> {
	return awaitReply(root, sessionId, "restart", id, timeoutMs);
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
	{ delivered: true } | { delivered: false; reason: string };

const REQUEST_ID = /^[\w-]+$/;

function repliesDir(
	root: string,
	sessionId: string,
	kind: RequestKind,
): string {
	return `${requestFile(root, sessionId, kind)}.replies`;
}

function writeReply(
	root: string,
	sessionId: string,
	kind: RequestKind,
	id: string,
	reply: SendReply | RestartReply,
): void {
	// A request line is not trusted to name a path.
	if (!REQUEST_ID.test(id)) return;
	const dir = repliesDir(root, sessionId, kind);
	const path = join(dir, id);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${path}.tmp`, JSON.stringify(reply));
		renameSync(`${path}.tmp`, path);
	} catch {
		// The request was handled; only the answer is lost, and the command says so.
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
	const stop = watchRequests(
		root,
		sessionId,
		"send",
		(lines) => {
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
						writeReply(
							root,
							sessionId,
							"send",
							id,
							refusal === undefined
								? { delivered: true }
								: { delivered: false, reason: refusal },
						);
				} catch {
					// A torn line: the request is lost, not the run.
				}
			}
			// Always: a send the run cannot deliver is answered with why.
		},
		() => true,
	);
	return () => {
		stop();
		rmSync(repliesDir(root, sessionId, "send"), {
			recursive: true,
			force: true,
		});
	};
}

/** The run's answer to send request `id`, or `undefined` when none came in time. */
export function awaitSendReply(
	root: string,
	sessionId: string,
	id: string,
	timeoutMs: number,
): Promise<SendReply | undefined> {
	return awaitReply(root, sessionId, "send", id, timeoutMs);
}

async function awaitReply<T>(
	root: string,
	sessionId: string,
	kind: RequestKind,
	id: string,
	timeoutMs: number,
): Promise<T | undefined> {
	const path = join(repliesDir(root, sessionId, kind), id);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const reply = JSON.parse(readFileSync(path, "utf8")) as T;
			rmSync(path, { force: true });
			return reply;
		} catch {
			// Not answered yet.
		}
		if (Date.now() >= deadline) return undefined;
		await promiseTimeout(50);
	}
}
