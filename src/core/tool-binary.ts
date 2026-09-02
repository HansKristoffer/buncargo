import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { chownToInvokingUser, getToolsDir } from "./hosts/paths";

/**
 * Locating the external binaries buncargo shells out to (`mkcert`,
 * `cloudflared`): an explicit env override wins, then a copy already on `PATH`,
 * then the version-pinned download cache.
 */

export interface ToolBinaryResolution {
	/** Path to spawn. With source `"cache"` the file may not be downloaded yet. */
	path: string;
	source: "override" | "path" | "cache";
	/** Whether something exists at `path` right now. */
	exists: boolean;
}

/** Download target for a tool, under `~/.buncargo/bin`. */
export function toolCachePath(fileName: string): string {
	return join(getToolsDir(), fileName);
}

/**
 * Where releases were cached before `~/.buncargo/bin`.
 *
 * Still read, never written: a machine that already downloaded the binary
 * should not fetch it again just because the cache moved.
 */
export function legacyToolCachePath(dirName: string, fileName: string): string {
	return join(tmpdir(), dirName, fileName);
}

/** Make a freshly downloaded binary executable and owned by the invoking user. */
export function finalizeToolBinary(path: string): void {
	chmodSync(path, 0o755);
	chownToInvokingUser(path);
}

export function resolveToolBinary(options: {
	/** Env override, already validated (see `runtime-flags`). */
	override?: string;
	/** Version-pinned download cache path. */
	cachePath: string;
	/** Previous cache location, adopted when it still holds the binary. */
	legacyCachePath?: string;
	/** Binary name to look up on `PATH`; omit to skip the lookup. */
	pathCommand?: string;
}): ToolBinaryResolution {
	const { override, cachePath, legacyCachePath, pathCommand } = options;

	if (override) {
		const path = resolve(override);
		return { path, source: "override", exists: existsSync(path) };
	}

	if (pathCommand) {
		const fromPath = lookupOnPath(pathCommand);
		if (fromPath) {
			return { path: fromPath, source: "path", exists: true };
		}
	}

	if (existsSync(cachePath)) {
		return { path: cachePath, source: "cache", exists: true };
	}

	if (legacyCachePath && existsSync(legacyCachePath)) {
		return { path: legacyCachePath, source: "cache", exists: true };
	}

	return { path: cachePath, source: "cache", exists: false };
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Extensions to try on Windows, where executability is a suffix rather than a
 * mode bit.
 */
function executableSuffixes(env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return [""];
	const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	return ["", ...pathext.split(";").filter(Boolean)];
}

/**
 * Find `command` on `PATH`, without spawning anything.
 *
 * This used to shell out to `command -v`. That is a builtin, so it looked
 * free, but it is still a fork and an exec of a shell, and a `buncargo dev`
 * reaches this for `docker`, `container` and `mkcert` before it has started
 * anything. Reading `PATH` directly answers the same question with a handful
 * of `access` calls.
 */
export function lookupOnPath(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	// A path rather than a bare name is not a PATH lookup at all.
	if (command.includes("/") || command.includes("\\")) {
		const path = isAbsolute(command) ? command : resolve(command);
		return isExecutableFile(path) ? path : undefined;
	}

	const suffixes = executableSuffixes(env);
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const suffix of suffixes) {
			const candidate = join(directory, `${command}${suffix}`);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return undefined;
}
