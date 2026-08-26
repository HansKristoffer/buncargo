import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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

export function resolveToolBinary(options: {
	/** Env override, already validated (see `runtime-flags`). */
	override?: string;
	/** Version-pinned download cache path. */
	cachePath: string;
	/** Binary name to look up on `PATH`; omit to skip the lookup. */
	pathCommand?: string;
}): ToolBinaryResolution {
	const { override, cachePath, pathCommand } = options;

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

	return { path: cachePath, source: "cache", exists: existsSync(cachePath) };
}

function lookupOnPath(command: string): string | undefined {
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
