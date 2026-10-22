import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { trimTrailingSlash } from "hanzio";

/**
 * Which file store a checkout uses: one per repository, the same on every
 * machine that clones it. The algorithm is part of the contract shared with
 * agentgate (docs/internals/checkout-files.md); change both or neither.
 */

const VALID_KEY = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/;
/** `scheme://[user[:pass]@]host[:port]/path` */
const URL_FORM =
	/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]+)(?::[^/]*)?(\/.*)$/;
/** `user@host:path` */
const SCP_FORM = /^[^@/:]+@([^/:]+):(.+)$/;

/** The key for an origin URL, or undefined when it does not make a valid one. */
export function repoKeyFromRemote(remote: string): string | undefined {
	const url = URL_FORM.exec(remote);
	const scp = url ? undefined : SCP_FORM.exec(remote);
	const raw = url
		? `${url[1]}${url[2]}`
		: scp
			? `${scp[1]}/${scp[2]}`
			: undefined;
	if (raw === undefined) return undefined;
	const key = trimTrailingSlash(raw)
		.replace(/\.git$/, "")
		.toLowerCase();
	return VALID_KEY.test(key) ? key : undefined;
}

/** The key for a repository without a usable origin. */
export function localRepoKey(realGitCommonDir: string): string {
	const digest = createHash("sha256").update(realGitCommonDir).digest("hex");
	return `local/${digest.slice(0, 16)}`;
}

function git(root: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The repository key for a checkout, or undefined outside a git repository.
 *
 * One fork in the common case: the common dir is only asked for when origin
 * is missing or unusable.
 */
export function resolveRepoKey(root: string): string | undefined {
	const remote = git(root, ["remote", "get-url", "origin"]);
	const fromRemote = remote ? repoKeyFromRemote(remote) : undefined;
	if (fromRemote) return fromRemote;
	const commonDir = git(root, ["rev-parse", "--git-common-dir"]);
	if (!commonDir) return undefined;
	return localRepoKey(realpathSync(resolve(root, commonDir)));
}
