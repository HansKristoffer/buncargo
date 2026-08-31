import { execSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

export function lookupOnPath(command: string): string | undefined {
	try {
		const found = execSync(`command -v ${command}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return found || undefined;
	} catch {
		return undefined;
	}
}
