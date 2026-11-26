/**
 * Package manager detection, `pnpm-workspace.yaml` parsing, and pinned Node
 * version checks (`.nvmrc` / `.node-version`).
 *
 * Single concern owner for deciding how a checkout installs dependencies and
 * runs package scripts across Bun, pnpm, Yarn and npm repositories.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, typedSwitch } from "hanzio";

export type PackageManagerName = "bun" | "pnpm" | "yarn" | "npm";

export interface PackageManagerSpec {
	readonly name: PackageManagerName;
	readonly lockfile: string;
	readonly installCommand: string;
	readonly frozenInstallDisplay: string;
	frozenInstallArgs(): string[];
	addDevCommand(pkg: string): string;
	runScriptArgs(script: string): string[];
	/** Run an installed package binary, never downloading one (`pnpm exec firebase …`). */
	execArgs(bin: string, args: readonly string[]): string[];
	/** {@link execArgs} as a person would type it. */
	execDisplay(bin: string, args: readonly string[]): string;
}

export interface DetectedLockfile {
	readonly path: string;
	readonly name: string;
	readonly manager: PackageManagerSpec;
}

const LOCKFILES: readonly {
	readonly file: string;
	readonly manager: PackageManagerName;
}[] = [
	{ file: "bun.lock", manager: "bun" },
	{ file: "bun.lockb", manager: "bun" },
	{ file: "pnpm-lock.yaml", manager: "pnpm" },
	{ file: "yarn.lock", manager: "yarn" },
	{ file: "package-lock.json", manager: "npm" },
];

const DEFAULT_LOCKFILE: Record<PackageManagerName, string> = {
	bun: "bun.lock",
	pnpm: "pnpm-lock.yaml",
	yarn: "yarn.lock",
	npm: "package-lock.json",
};

/** Build the command table for a package manager. */
function packageManagerSpec(
	name: PackageManagerName,
	lockfile = DEFAULT_LOCKFILE[name],
): PackageManagerSpec {
	return typedSwitch(name, {
		bun: () => ({
			name: "bun" as const,
			lockfile,
			installCommand: "bun install",
			frozenInstallDisplay: "bun install --frozen-lockfile",
			frozenInstallArgs: () => [
				process.execPath,
				"install",
				"--frozen-lockfile",
			],
			addDevCommand: (pkg) => `bun add -d ${pkg}`,
			runScriptArgs: (script) => [process.execPath, "run", script],
			execArgs: (bin, args) => [
				process.execPath,
				"x",
				"--no-install",
				bin,
				...args,
			],
			execDisplay: (bin, args) => ["bunx --no-install", bin, ...args].join(" "),
		}),
		pnpm: () => ({
			name: "pnpm" as const,
			lockfile,
			installCommand: "pnpm install",
			frozenInstallDisplay: "pnpm install --frozen-lockfile",
			frozenInstallArgs: () => ["pnpm", "install", "--frozen-lockfile"],
			addDevCommand: (pkg) => `pnpm add -D ${pkg}`,
			runScriptArgs: (script) => ["pnpm", "run", script],
			execArgs: (bin, args) => ["pnpm", "exec", bin, ...args],
			execDisplay: (bin, args) => ["pnpm exec", bin, ...args].join(" "),
		}),
		yarn: () => ({
			name: "yarn" as const,
			lockfile,
			installCommand: "yarn install",
			frozenInstallDisplay: "yarn install --frozen-lockfile",
			frozenInstallArgs: () => ["yarn", "install", "--frozen-lockfile"],
			addDevCommand: (pkg) => `yarn add -D ${pkg}`,
			runScriptArgs: (script) => ["yarn", "run", script],
			execArgs: (bin, args) => ["yarn", bin, ...args],
			execDisplay: (bin, args) => ["yarn", bin, ...args].join(" "),
		}),
		npm: () => ({
			name: "npm" as const,
			lockfile,
			installCommand: "npm install",
			frozenInstallDisplay: "npm ci",
			frozenInstallArgs: () => ["npm", "ci"],
			addDevCommand: (pkg) => `npm install -D ${pkg}`,
			runScriptArgs: (script) => ["npm", "run", script],
			execArgs: (bin, args) => ["npm", "exec", "--no", "--", bin, ...args],
			execDisplay: (bin, args) => ["npm exec --no --", bin, ...args].join(" "),
		}),
	});
}

/** First known lockfile directly in `dir`, or `undefined` when none exists. */
export function findLockfile(dir: string): DetectedLockfile | undefined {
	for (const entry of LOCKFILES) {
		const path = join(dir, entry.file);
		if (existsSync(path)) {
			return {
				path,
				name: entry.file,
				manager: packageManagerSpec(entry.manager, entry.file),
			};
		}
	}
	return undefined;
}

/** Parse a `package.json` `"packageManager"` field (`"pnpm@10.12.4"` -> `"pnpm"`). */
export function parsePackageManagerField(
	value: unknown,
): PackageManagerName | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim().split("@")[0]?.toLowerCase();
	if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") {
		return name;
	}
	return undefined;
}

function readPackageManagerFromManifest(
	dir: string,
): PackageManagerName | undefined {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
		return isRecord(parsed)
			? parsePackageManagerField(parsed.packageManager)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Detect the package manager for `dir`: lockfile first, then
 * `pnpm-workspace.yaml`, then `package.json` `packageManager`, else Bun.
 */
export function detectPackageManager(dir: string): PackageManagerSpec {
	const lockfile = findLockfile(dir);
	if (lockfile) return lockfile.manager;

	if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
		return packageManagerSpec("pnpm");
	}

	const fromManifest = readPackageManagerFromManifest(dir);
	if (fromManifest) return packageManagerSpec(fromManifest);

	return packageManagerSpec("bun");
}

/**
 * Extract positive workspace glob patterns from `pnpm-workspace.yaml`'s
 * `packages:` list. Pure, zero external YAML dependencies.
 */
export function parsePnpmWorkspacePackages(
	content: string,
): string[] | undefined {
	const patterns: string[] = [];
	let inPackages = false;
	let listIndent: number | undefined;

	for (const rawLine of content.split(/\r?\n/)) {
		if (rawLine.trimStart().startsWith("#")) continue;
		const uncommented = rawLine.replace(/\s+#.*$/, "");
		if (!uncommented.trim()) continue;

		if (!inPackages) {
			if (/^packages\s*:\s*$/.test(uncommented.trim())) {
				inPackages = true;
				continue;
			}
			const inline = /^packages\s*:\s*\[([^\]]*)\]\s*$/.exec(
				uncommented.trim(),
			);
			if (inline?.[1] !== undefined) {
				const items = inline[1]
					.split(",")
					.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
					.filter((entry) => entry.length > 0 && !entry.startsWith("!"));
				return items.length > 0 ? items : undefined;
			}
			continue;
		}

		const itemMatch = /^([ \t]*)-\s+(.+?)\s*$/.exec(uncommented);
		if (itemMatch) {
			const indent = itemMatch[1]?.length ?? 0;
			if (listIndent === undefined) listIndent = indent;
			if (indent < listIndent) break;
			const rawValue = (itemMatch[2] ?? "").replace(/^["']|["']$/g, "").trim();
			if (rawValue && !rawValue.startsWith("!")) {
				patterns.push(rawValue);
			}
			continue;
		}

		// A new top-level key ends the `packages:` list.
		if (!/^[ \t]/.test(uncommented)) break;
	}

	return patterns.length > 0 ? patterns : undefined;
}

/** Read positive workspace patterns from `<dir>/pnpm-workspace.yaml`, or `undefined`. */
export function readPnpmWorkspacePackages(dir: string): string[] | undefined {
	const path = join(dir, "pnpm-workspace.yaml");
	if (!existsSync(path)) return undefined;
	try {
		return parsePnpmWorkspacePackages(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

const NUMERIC_NODE_PIN = /^v?(\d+(?:\.\d+){0,2})$/;

/** Parse a pinned numeric Node version from `.nvmrc` / `.node-version` contents. */
export function parsePinnedNodeVersion(content: string): string | undefined {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = NUMERIC_NODE_PIN.exec(line);
		return match?.[1];
	}
	return undefined;
}

/** Read a numeric Node version pin from `<dir>/.nvmrc` or `<dir>/.node-version`. */
export function readPinnedNodeVersion(
	dir: string,
): { version: string; source: string } | undefined {
	for (const file of [".nvmrc", ".node-version"]) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		try {
			const version = parsePinnedNodeVersion(readFileSync(path, "utf8"));
			if (version) return { version, source: file };
		} catch {
			// Unreadable file: check the next candidate.
		}
	}
	return undefined;
}

/** Extract `major.minor.patch` from `node --version` output (`v22.14.0`). */
export function parseNodeVersionOutput(output: string): string | undefined {
	const match = /v?(\d+\.\d+\.\d+)/.exec(output.trim());
	return match?.[1];
}

/** Whether `actual` (`22.14.0`) satisfies a numeric pin (`22`, `22.14`, `22.14.0`). */
export function matchesNodeVersion(actual: string, pinned: string): boolean {
	const actualParts = actual.replace(/^v/, "").split(".");
	const pinnedParts = pinned.replace(/^v/, "").split(".");
	return pinnedParts.every((part, index) => actualParts[index] === part);
}
