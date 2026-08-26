import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The self-contained daemon file the system service actually executes.
 *
 * The service cannot run the normal CLI entrypoint. Under `bunx buncargo` that
 * lives in a project's `node_modules`, which means three problems at once: it
 * is code-split across sibling chunks, it disappears when the project
 * reinstalls dependencies, and macOS denies a root daemon any path under
 * `~/Documents` or `~/Desktop`, so launchd cannot even read it.
 *
 * Installing a single bundled file into a root-owned directory answers all
 * three, and stops root from executing a user-writable file.
 */

export const HOSTS_DAEMON_DIR = "/usr/local/libexec/buncargo";

const BUNDLE_PREFIX = "hostsd-";
const BUNDLE_SUFFIX = ".js";

/** Where the bundle for a given buncargo version is installed. */
export function hostsDaemonBundlePath(version: string): string {
	return join(HOSTS_DAEMON_DIR, `${BUNDLE_PREFIX}${version}${BUNDLE_SUFFIX}`);
}

/** Is this a path we installed, and may therefore remove? */
export function isManagedBundlePath(path: string): boolean {
	return (
		path.startsWith(`${HOSTS_DAEMON_DIR}/`) &&
		path.endsWith(BUNDLE_SUFFIX) &&
		!path.slice(HOSTS_DAEMON_DIR.length + 1).includes("/")
	);
}

/** Installed bundles other than `keep`, so an upgrade does not accumulate them. */
export function supersededBundles(keep: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(HOSTS_DAEMON_DIR);
	} catch {
		return [];
	}
	return entries
		.filter(
			(entry) =>
				entry.startsWith(BUNDLE_PREFIX) && entry.endsWith(BUNDLE_SUFFIX),
		)
		.map((entry) => join(HOSTS_DAEMON_DIR, entry))
		.filter((path) => path !== keep);
}

interface PackageRoot {
	dir: string;
	version: string;
}

let cachedRoot: PackageRoot | undefined;

/**
 * Walk up to the buncargo package root.
 *
 * Resolving relative to this module's own path is not enough: the bundler
 * code-splits shared modules into `dist/chunk-*.js`, so the depth from here to
 * the package root is not fixed.
 */
function packageRoot(): PackageRoot {
	if (cachedRoot) return cachedRoot;

	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const version = JSON.parse(readFileSync(manifest, "utf-8")).version;
			cachedRoot = {
				dir,
				version: typeof version === "string" ? version : "0.0.0",
			};
			return cachedRoot;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error("Could not locate the buncargo package root.");
		}
		dir = parent;
	}
}

export function buncargoVersion(): string {
	return packageRoot().version;
}

/** The built bundle to install, or a message naming what to do about it. */
export function readDaemonBundleSource(): {
	contents: string;
	version: string;
} {
	const { dir, version } = packageRoot();
	const source = join(dir, "dist", "hostsd.js");
	if (!existsSync(source)) {
		throw new Error(
			`Named-hosts daemon bundle is missing at ${source}. Run \`bun run build\` and try again.`,
		);
	}
	return { contents: readFileSync(source, "utf-8"), version };
}
