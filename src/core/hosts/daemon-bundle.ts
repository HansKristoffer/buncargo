import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireBuncargoPackage } from "../version";

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

/** The built bundle to install, or a message naming what to do about it. */
export function readDaemonBundleSource(): {
	contents: string;
	version: string;
} {
	const { dir, version } = requireBuncargoPackage();
	const source = join(dir, "dist", "hostsd.js");
	if (!existsSync(source)) {
		throw new Error(
			`Named-hosts daemon bundle is missing at ${source}. Run \`bun run build\` and try again.`,
		);
	}
	return { contents: readFileSync(source, "utf-8"), version };
}

/** Identity of a bundle's contents, short enough to sit in a manifest. */
export function hashDaemonBundle(contents: string): string {
	return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

/**
 * Hash of the bundle this CLI would install, or `undefined` when there is none
 * to read.
 *
 * The installed path carries only the version, so a daemon rebuilt at the same
 * version is invisible to a path comparison — which is how a machine can run
 * days-old daemon code while every staleness check reports it current. Absent
 * is "cannot tell": a consumer installed without `dist/` must not be told its
 * service is stale on every command.
 */
export function currentDaemonBundleHash(): string | undefined {
	try {
		return hashDaemonBundle(readDaemonBundleSource().contents);
	} catch {
		return undefined;
	}
}
