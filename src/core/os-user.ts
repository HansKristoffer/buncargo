import { userInfo } from "node:os";

/**
 * The OS user this process runs as, or "" when the system cannot say.
 *
 * Stamped on every container as `buncargo.user`, so a sweep can tell its own
 * stacks from another user's on a shared Docker daemon (a CI runner beside a
 * developer). An empty answer never matches a label, so it reads as "not ours".
 */
export function currentOsUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}
