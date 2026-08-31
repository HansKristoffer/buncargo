import { existsSync, rmSync } from "node:fs";
import { readJsonDocumentSync, writeJsonDocumentSync } from "../registry-file";
import {
	buncargoVersion,
	currentDaemonBundleHash,
	HOSTS_DAEMON_DIR,
	hashDaemonBundle,
	hostsDaemonBundlePath,
	isManagedBundlePath,
	readDaemonBundleSource,
	supersededBundles,
} from "./daemon-bundle";
import {
	chownToInvokingUser,
	getServiceManifestPath,
	type InvokingUser,
	invokingUserIdentity,
} from "./paths";
import { type PrivilegedRunner, systemPrivilegedRunner } from "./privileged";
import {
	buildLaunchdPlist,
	buildSystemdUnit,
	LAUNCHD_LABEL,
	LAUNCHD_PLIST,
	SYSTEMD_PATH,
	SYSTEMD_UNIT,
} from "./service-files";

/**
 * Installing, removing and validating the system service that owns `:443`.
 *
 * Installs are all-or-nothing: a unit file left behind by a failed load would
 * make `isHostsServiceInstalled()` report success, and every later run would
 * skip setup and silently fall back to `localhost:port`.
 */

export {
	LAUNCHD_LABEL,
	LAUNCHD_PLIST,
	SYSTEMD_PATH,
	SYSTEMD_UNIT,
} from "./service-files";

export const HOSTS_SERVICE_MANIFEST_VERSION = 1;

export interface HostsServiceManifest {
	version: number;
	/** Interpreter the service runs, normally the Bun binary. */
	program: string;
	/** Arguments, the first of which is the installed daemon bundle. */
	args: string[];
	/**
	 * Contents of the bundle that was installed. Absent in manifests written
	 * before the field existed, which read as "cannot compare".
	 */
	bundleHash?: string;
	installedAt: string;
}

function privilegeError(action: string): Error {
	return new Error(
		`Named hosts need admin rights to ${action}. Re-run and enter your password, or use --no-hosts to stay on localhost:port.`,
	);
}

export const HOSTS_SERVICE_START_MESSAGE =
	"Named-hosts service failed to start. Run `buncargo hosts install` or use --no-hosts to stay on localhost:port.";

/** Turn a raw sudo/launchctl/systemctl failure into a line the CLI can print. */
export function toHostsUserMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (
		message.startsWith("Command failed:") ||
		/Bootstrap failed/i.test(message) ||
		/\blaunchctl\b/i.test(message) ||
		/\bsystemctl\b/i.test(message)
	) {
		return HOSTS_SERVICE_START_MESSAGE;
	}
	return message;
}

/**
 * What the service runs: the Bun binary against the bundle we install into a
 * root-owned directory. `process.execPath` is left as-is; the manifest records
 * it so a Bun that later moves is reported as stale rather than failing
 * silently.
 */
export function resolveHostsDaemonCommand(version = buncargoVersion()): {
	program: string;
	args: string[];
} {
	return {
		program: process.execPath,
		args: [hostsDaemonBundlePath(version)],
	};
}

/**
 * Path of the unit file for this platform, or `undefined` where named hosts
 * are unsupported.
 */
export function hostsServicePath(): string | undefined {
	if (process.platform === "darwin") return LAUNCHD_PLIST;
	if (process.platform === "linux") return SYSTEMD_PATH;
	return undefined;
}

export function isHostsServiceInstalled(): boolean {
	const path = hostsServicePath();
	return path !== undefined && existsSync(path);
}

function validateManifest(value: unknown): HostsServiceManifest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const manifest = value as Partial<HostsServiceManifest>;
	if (manifest.version !== HOSTS_SERVICE_MANIFEST_VERSION) return undefined;
	if (typeof manifest.program !== "string") return undefined;
	if (!Array.isArray(manifest.args)) return undefined;
	if (!manifest.args.every((arg) => typeof arg === "string")) return undefined;
	return {
		version: manifest.version,
		program: manifest.program,
		args: manifest.args,
		...(typeof manifest.bundleHash === "string"
			? { bundleHash: manifest.bundleHash }
			: {}),
		installedAt:
			typeof manifest.installedAt === "string" ? manifest.installedAt : "",
	};
}

export function readHostsServiceManifest(): HostsServiceManifest | undefined {
	return readJsonDocumentSync(getServiceManifestPath(), validateManifest);
}

export function writeHostsServiceManifest(input: {
	program: string;
	args: string[];
	bundleHash?: string;
}): void {
	const manifest: HostsServiceManifest = {
		version: HOSTS_SERVICE_MANIFEST_VERSION,
		program: input.program,
		args: input.args,
		...(input.bundleHash ? { bundleHash: input.bundleHash } : {}),
		installedAt: new Date().toISOString(),
	};
	writeJsonDocumentSync(getServiceManifestPath(), manifest, {
		afterWrite: chownToInvokingUser,
	});
}

/**
 * Paths the installed service needs that are no longer on disk.
 *
 * The interpreter is whichever Bun ran the install, so a Bun that is upgraded
 * to a new path, or removed, leaves a machine-wide daemon pointing at nothing.
 */
export function missingServiceTargets(
	manifest: HostsServiceManifest,
	fileExists: (path: string) => boolean = existsSync,
): string[] {
	const targets = [manifest.program, manifest.args[0]];
	return targets.filter(
		(target): target is string =>
			typeof target === "string" && target.length > 0 && !fileExists(target),
	);
}

/**
 * A human-readable reason the installed service cannot work, if any.
 *
 * Split from `describeStaleHostsService` so the wording and the staleness rules
 * can be tested without a real unit file on the machine running the tests.
 */
export function describeStaleService(input: {
	installed: boolean;
	manifest: HostsServiceManifest | undefined;
	/** Bundle path the running CLI would install; a mismatch means an upgrade. */
	expectedBundle?: string;
	/** Contents of that bundle; a mismatch means a rebuild at the same version. */
	expectedBundleHash?: string;
	fileExists?: (path: string) => boolean;
}): string | undefined {
	const { installed, manifest, expectedBundle, expectedBundleHash } = input;
	const fileExists = input.fileExists ?? existsSync;
	if (!installed) return undefined;
	if (!manifest) {
		return "Named-hosts service is installed but its manifest is missing. Run `buncargo hosts install` to repair it.";
	}

	const missing = missingServiceTargets(manifest, fileExists);
	if (missing.length > 0) {
		return `Named-hosts service points at ${missing.join(", ")}, which no longer exists. Run \`buncargo hosts install\` to repair it.`;
	}

	// The bundle path carries the version it was built from, so an upgraded CLI
	// would otherwise keep talking to a daemon running the old code.
	if (expectedBundle && manifest.args[0] !== expectedBundle) {
		return `Named-hosts service runs ${manifest.args[0]}, but this buncargo installs ${expectedBundle}. Run \`buncargo hosts install\` to update it.`;
	}

	// The path stops at the version, so a daemon rebuilt during development —
	// or shipped in a patch that reuses the version — passes every check above
	// while running code that no longer matches this CLI.
	if (
		expectedBundleHash &&
		manifest.bundleHash &&
		manifest.bundleHash !== expectedBundleHash
	) {
		return "Named-hosts service runs a daemon built from different code than this buncargo. Run `buncargo hosts install` to update it.";
	}
	return undefined;
}

export function describeStaleHostsService(): string | undefined {
	return describeStaleService({
		installed: isHostsServiceInstalled(),
		manifest: readHostsServiceManifest(),
		expectedBundle: hostsDaemonBundlePath(buncargoVersion()),
		expectedBundleHash: currentDaemonBundleHash(),
	});
}

/** Matches launchd's own SIGTERM-to-SIGKILL escalation for a wedged job. */
const UNLOAD_TIMEOUT_MS = 20_000;
const UNLOAD_POLL_MS = 100;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isLaunchdJobLoaded(runner: PrivilegedRunner): boolean {
	try {
		runner.run("launchctl", ["print", `system/${LAUNCHD_LABEL}`], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * `launchctl bootout` returns before the job is actually gone, and
 * bootstrapping one that is still on its way out fails with EBUSY. Without
 * this wait, reinstalling over a running service is a coin flip: the failed
 * bootstrap rolls the install back, so every other attempt appears to work.
 */
function waitForLaunchdUnload(runner: PrivilegedRunner): void {
	const deadline = Date.now() + UNLOAD_TIMEOUT_MS;
	while (isLaunchdJobLoaded(runner)) {
		if (Date.now() >= deadline) return;
		sleepSync(UNLOAD_POLL_MS);
	}
}

function activateService(runner: PrivilegedRunner): void {
	if (process.platform === "darwin") {
		try {
			runner.run("launchctl", ["bootout", `system/${LAUNCHD_LABEL}`], {
				stdio: "ignore",
			});
		} catch {
			// not loaded
		}
		waitForLaunchdUnload(runner);
		runner.run("launchctl", ["bootstrap", "system", LAUNCHD_PLIST], {
			stdio: "ignore",
		});
		return;
	}
	runner.run("systemctl", ["daemon-reload"], { stdio: "ignore" });
	runner.run("systemctl", ["enable", "--now", SYSTEMD_UNIT], {
		stdio: "ignore",
	});
}

/**
 * Drop bundles from earlier versions once the new one is loaded.
 *
 * Best-effort and deliberately after activation: failing to tidy up must not
 * fail an install that already works.
 */
function removeSupersededBundles(runner: PrivilegedRunner, keep: string): void {
	for (const path of supersededBundles(keep)) {
		try {
			runner.removeFile(path);
		} catch {
			// leave it; a stale bundle is inert once nothing points at it
		}
	}
}

export function installHostsService(
	options: {
		user?: InvokingUser;
		runner?: PrivilegedRunner;
		/** Injected by tests so install can run without a built `dist/`. */
		bundle?: { contents: string; version: string };
	} = {},
): void {
	const path = hostsServicePath();
	if (!path) {
		throw new Error(
			"Named hosts service install is only supported on macOS and Linux.",
		);
	}

	const user = options.user ?? invokingUserIdentity();
	const runner = options.runner ?? systemPrivilegedRunner();
	const bundle = options.bundle ?? readDaemonBundleSource();
	const { program, args } = resolveHostsDaemonCommand(bundle.version);
	const bundlePath = args[0] as string;
	const input = { program, args, user };
	const contents =
		process.platform === "darwin"
			? buildLaunchdPlist(input)
			: buildSystemdUnit(input);

	try {
		runner.authorize();
		runner.run("mkdir", ["-p", HOSTS_DAEMON_DIR]);
		runner.writeFile(bundlePath, bundle.contents);
		runner.writeFile(path, contents);
	} catch {
		throw privilegeError("install the :443 proxy service");
	}

	try {
		activateService(runner);
	} catch (error) {
		// Roll back, or isHostsServiceInstalled() would report a service that
		// never loaded and every later run would skip setup.
		try {
			runner.removeFile(path);
			runner.removeFile(bundlePath);
		} catch {
			// leave it; the manifest is not written, so staleness reporting covers it
		}
		throw new Error(toHostsUserMessage(error));
	}

	writeHostsServiceManifest({
		program,
		args,
		bundleHash: hashDaemonBundle(bundle.contents),
	});
	removeSupersededBundles(runner, bundlePath);
}

export function uninstallHostsService(
	options: { runner?: PrivilegedRunner } = {},
): void {
	const path = hostsServicePath();
	if (!path) return;

	const installed = existsSync(path);
	const manifest = readHostsServiceManifest();
	if (!installed && !manifest) return;

	const runner = options.runner ?? systemPrivilegedRunner();
	try {
		runner.authorize();
	} catch {
		throw privilegeError("remove the :443 proxy service");
	}

	// Unload even when the file is gone: the service can still be loaded from a
	// plist that was deleted by hand.
	try {
		if (process.platform === "darwin") {
			runner.run("launchctl", ["bootout", `system/${LAUNCHD_LABEL}`], {
				stdio: "ignore",
			});
		} else {
			runner.run("systemctl", ["disable", "--now", SYSTEMD_UNIT], {
				stdio: "ignore",
			});
		}
	} catch {
		// not loaded
	}

	if (installed) {
		try {
			runner.removeFile(path);
			if (process.platform === "linux") {
				runner.run("systemctl", ["daemon-reload"], { stdio: "ignore" });
			}
		} catch {
			throw privilegeError("remove the :443 proxy service");
		}
	}

	// Only paths we installed: the manifest is user-writable, so a tampered
	// entry must not turn `hosts uninstall` into an arbitrary root delete.
	const bundlePath = manifest?.args[0];
	if (bundlePath && isManagedBundlePath(bundlePath)) {
		try {
			runner.removeFile(bundlePath);
		} catch {
			// best-effort; the bundle is inert with no service pointing at it
		}
	}

	removeHostsServiceManifest();
}

function removeHostsServiceManifest(): void {
	try {
		rmSync(getServiceManifestPath(), { force: true });
	} catch {
		// already gone
	}
}
