import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** What the git config files say about origin, when they say it plainly. */
type OriginInConfig = { url: string } | "none";

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * The repository's git directory and common directory, found the way git
 * finds them from `root`: the nearest `.git` above it, a worktree's `.git`
 * file pointing at its own git directory, whose `commondir` names the main
 * one.
 */
function findGitDirs(
	root: string,
): { gitDir: string; commonDir: string } | undefined {
	for (let dir = resolve(root); ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		if (existsSync(dotGit)) {
			const gitDir = statSync(dotGit).isFile()
				? gitDirFromFile(dotGit)
				: dotGit;
			if (gitDir === undefined) return undefined;
			const common = readText(join(gitDir, "commondir"))?.trim();
			return {
				gitDir,
				commonDir: common ? resolve(gitDir, common) : gitDir,
			};
		}
		if (dirname(dir) === dir) return undefined;
	}
}

function gitDirFromFile(dotGit: string): string | undefined {
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
	return match?.[1] ? resolve(dirname(dotGit), match[1]) : undefined;
}

/**
 * The URL `git remote get-url origin` prints, read from the config files, or
 * undefined when only git can say: a file that rewrites URLs (`insteadOf`) or
 * includes another, a per-worktree config, `GIT_*` variables that move the
 * repository or its config, or a line this reader does not parse.
 */
function originFromConfig(gitDirs: {
	gitDir: string;
	commonDir: string;
}): OriginInConfig | undefined {
	if (
		Object.keys(process.env).some((name) =>
			/^GIT_(DIR|COMMON_DIR|CONFIG|WORK_TREE)/.test(name),
		)
	)
		return undefined;
	if (existsSync(join(gitDirs.gitDir, "config.worktree"))) return undefined;
	const home = process.env.HOME ?? homedir();
	const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
	const others = [
		"/etc/gitconfig",
		"/opt/homebrew/etc/gitconfig",
		"/usr/local/etc/gitconfig",
		join(xdg, "git", "config"),
		join(home, ".gitconfig"),
	].flatMap((path) => readText(path) ?? []);
	const repository = readText(join(gitDirs.commonDir, "config"));
	if (repository === undefined) return undefined;
	if (
		[...others, repository].some((text) => /insteadof|\[\s*include/i.test(text))
	)
		return undefined;
	return parseOrigin(repository);
}

/**
 * The first `url` of `[remote "origin"]`, "none" when there is no such
 * section, or undefined for a section or value that needs git's own parser.
 */
export function parseOrigin(config: string): OriginInConfig | undefined {
	let inOrigin = false;
	let sawOrigin = false;
	for (const line of config.split(/\r?\n/)) {
		const header = /^\s*\[([^\]]*)\](.*)$/.exec(line);
		if (header) {
			const [, section = "", rest = ""] = header;
			if (rest.trim() !== "" && !/^\s*[#;]/.test(rest)) return undefined;
			const remote = /^\s*remote\s+"([^"]*)"\s*$/i.exec(section);
			inOrigin = remote?.[1] === "origin";
			if (inOrigin) sawOrigin = true;
			else if (/origin/i.test(section) && !remote) return undefined;
			continue;
		}
		if (!inOrigin) continue;
		const url = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line);
		if (!url) continue;
		const value = url[1] ?? "";
		if (value === "" || /["\\#;]/.test(value)) return undefined;
		return { url: value };
	}
	return sawOrigin ? undefined : "none";
}

/**
 * The repository key for a checkout, or undefined outside a git repository.
 *
 * Read from the git config files without forking in the common case: a load
 * with `checkoutFiles` resolves this on every command. Git answers when the
 * config is beyond {@link parseOrigin}, with the same result.
 */
export function resolveRepoKey(root: string): string | undefined {
	const gitDirs = findGitDirs(root);
	if (!gitDirs) return undefined;
	const origin = originFromConfig(gitDirs);
	if (origin === undefined) return resolveRepoKeyWithGit(root);
	const fromRemote =
		origin === "none" ? undefined : repoKeyFromRemote(origin.url);
	return fromRemote ?? localRepoKey(realpathSync(gitDirs.commonDir));
}

/** {@link resolveRepoKey} by asking git: one fork when origin makes a key. */
function resolveRepoKeyWithGit(root: string): string | undefined {
	const remote = git(root, ["remote", "get-url", "origin"]);
	const fromRemote = remote ? repoKeyFromRemote(remote) : undefined;
	if (fromRemote) return fromRemote;
	const commonDir = git(root, ["rev-parse", "--git-common-dir"]);
	if (!commonDir) return undefined;
	return localRepoKey(realpathSync(resolve(root, commonDir)));
}
