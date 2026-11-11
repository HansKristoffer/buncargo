import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { chownToInvokingUser, getStateDir } from "../state-paths";
import { getPidfilePath } from "./paths";

/**
 * Which process is running the `:443` proxy.
 *
 * Shared by the daemon and the CLI commands that look for it, so it sits below
 * both: the daemon must not import the CLI-side client, which reaches into the
 * container runtimes to name a port squatter.
 */

export function readDaemonPid(): number | undefined {
	const path = getPidfilePath();
	if (!existsSync(path)) return undefined;
	const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}

export function writeDaemonPid(pid: number): void {
	mkdirSync(getStateDir(), { recursive: true });
	const path = getPidfilePath();
	writeFileSync(path, `${pid}\n`);
	chownToInvokingUser(path);
}

/**
 * Forget the running daemon as it exits, when that daemon is this process.
 *
 * Every exit, not just a signal: an idle exit that left the pidfile behind
 * named a dead pid. A daemon that started since owns the file.
 */
export function releaseDaemonPid(pid: number): void {
	if (readDaemonPid() !== pid) return;
	rmSync(getPidfilePath(), { force: true });
}
