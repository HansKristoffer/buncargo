import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServiceManifestPath } from "./paths";
import type { PrivilegedRunner } from "./privileged";
import {
	describeStaleService,
	HOSTS_SERVICE_START_MESSAGE,
	type HostsServiceManifest,
	hostsServicePath,
	installHostsService,
	isHostsServiceInstalled,
	missingServiceTargets,
	readHostsServiceManifest,
	toHostsUserMessage,
	uninstallHostsService,
	writeHostsServiceManifest,
} from "./service";

const user = {
	user: "kristoffer",
	uid: 501,
	gid: 20,
	home: "/Users/kristoffer",
};

interface RecordedCall {
	command: string;
	args: string[];
}

function recordingRunner(
	options: {
		failOn?: (command: string, args: string[]) => boolean;
		/** `launchctl print` succeeds only while the job is still loaded. */
		stillLoaded?: () => boolean;
	} = {},
): { runner: PrivilegedRunner; calls: RecordedCall[]; files: Set<string> } {
	const calls: RecordedCall[] = [];
	const files = new Set<string>();
	const runner: PrivilegedRunner = {
		isRoot: () => false,
		authorize() {
			calls.push({ command: "authorize", args: [] });
		},
		run(command, args) {
			calls.push({ command, args });
			if (args[0] === "print" && !options.stillLoaded?.()) {
				throw new Error(`${command} ${args.join(" ")}: could not find job`);
			}
			if (options.failOn?.(command, args)) {
				throw new Error(`${command} ${args.join(" ")} failed`);
			}
		},
		writeFile(path) {
			calls.push({ command: "writeFile", args: [path] });
			files.add(path);
		},
		removeFile(path) {
			calls.push({ command: "removeFile", args: [path] });
			files.delete(path);
		},
	};
	return { runner, calls, files };
}

const isDarwin = process.platform === "darwin";
const activateFails = (command: string, args: string[]): boolean =>
	isDarwin
		? command === "launchctl" && args[0] === "bootstrap"
		: command === "systemctl" && args[0] === "enable";

function commandNames(calls: RecordedCall[]): string[] {
	return calls.map((call) => call.command);
}

/** Point `~/.buncargo` at a temp dir so tests never touch the real home. */
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
	previousHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "buncargo-service-test-"));
	process.env.HOME = home;
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

describe("service manifest", () => {
	it("round-trips what the service was installed with", () => {
		writeHostsServiceManifest({
			program: "/opt/homebrew/bin/bun",
			args: ["/usr/local/libexec/buncargo/hostsd-6.0.0.js"],
		});
		const manifest = readHostsServiceManifest();
		expect(manifest?.program).toBe("/opt/homebrew/bin/bun");
		expect(manifest?.args[0]).toBe(
			"/usr/local/libexec/buncargo/hostsd-6.0.0.js",
		);
		expect(manifest?.installedAt).not.toBe("");
	});

	it("records the bundle contents when the installer supplies them", () => {
		writeHostsServiceManifest({
			program: "/opt/homebrew/bin/bun",
			args: ["/usr/local/libexec/buncargo/hostsd-6.0.0.js"],
			bundleHash: "abc123",
		});
		expect(readHostsServiceManifest()?.bundleHash).toBe("abc123");
	});

	it("reads as absent when the file is missing", () => {
		expect(readHostsServiceManifest()).toBeUndefined();
	});

	it("reads as absent on a version mismatch", async () => {
		await Bun.write(
			getServiceManifestPath(),
			JSON.stringify({ version: 999, program: "/bin/bun", args: ["x"] }),
		);
		expect(readHostsServiceManifest()).toBeUndefined();
	});
});

describe("missingServiceTargets", () => {
	const manifest: HostsServiceManifest = {
		version: 1,
		program: "/opt/homebrew/bin/bun",
		args: ["/usr/local/libexec/buncargo/hostsd-6.0.0.js"],
		installedAt: new Date().toISOString(),
	};

	it("is empty while every target is present", () => {
		expect(missingServiceTargets(manifest, () => true)).toEqual([]);
	});

	it("reports a bundle removed from the managed directory", () => {
		const missing = missingServiceTargets(
			manifest,
			(path) => !path.includes("libexec"),
		);
		expect(missing).toEqual(["/usr/local/libexec/buncargo/hostsd-6.0.0.js"]);
	});

	it("reports an interpreter that moved with a Bun upgrade", () => {
		expect(missingServiceTargets(manifest, () => false)).toEqual([
			"/opt/homebrew/bin/bun",
			"/usr/local/libexec/buncargo/hostsd-6.0.0.js",
		]);
	});
});

describe("toHostsUserMessage", () => {
	it("hides raw sudo and launchctl failures", () => {
		expect(
			toHostsUserMessage(
				new Error(
					"Command failed: sudo launchctl bootstrap system /Library/LaunchDaemons/dev.buncargo.hosts.plist",
				),
			),
		).toBe(HOSTS_SERVICE_START_MESSAGE);
		expect(
			toHostsUserMessage(new Error("Bootstrap failed: 5: Input/output error")),
		).toBe(HOSTS_SERVICE_START_MESSAGE);
		expect(
			toHostsUserMessage(
				new Error("Named hosts were declined on this machine."),
			),
		).toBe("Named hosts were declined on this machine.");
	});
});

describe("describeStaleService", () => {
	const manifest: HostsServiceManifest = {
		version: 1,
		program: "/opt/homebrew/bin/bun",
		args: ["/usr/local/libexec/buncargo/hostsd-6.0.0.js"],
		installedAt: new Date().toISOString(),
	};

	it("says nothing when no service is installed", () => {
		expect(
			describeStaleService({ installed: false, manifest: undefined }),
		).toBeUndefined();
		expect(
			describeStaleService({
				installed: false,
				manifest,
				fileExists: () => false,
			}),
		).toBeUndefined();
	});

	it("says nothing while every recorded path is present", () => {
		expect(
			describeStaleService({
				installed: true,
				manifest,
				fileExists: () => true,
			}),
		).toBeUndefined();
	});

	it("flags an install with no manifest as needing repair", () => {
		expect(
			describeStaleService({ installed: true, manifest: undefined }),
		).toContain("buncargo hosts install");
	});

	it("names the path that disappeared", () => {
		const message = describeStaleService({
			installed: true,
			manifest,
			fileExists: (path) => !path.includes("libexec"),
		});
		expect(message).toContain("/usr/local/libexec/buncargo/hostsd-6.0.0.js");
		expect(message).toContain("buncargo hosts install");
	});

	it("flags a Bun that moved out from under the service", () => {
		const message = describeStaleService({
			installed: true,
			manifest,
			fileExists: (path) => path !== "/opt/homebrew/bin/bun",
		});
		expect(message).toContain("/opt/homebrew/bin/bun");
	});

	// The bundle path carries the version it was built from, so an upgraded CLI
	// would otherwise keep talking to a daemon running the old code.
	it("flags a service still pointing at a previous version's bundle", () => {
		const message = describeStaleService({
			installed: true,
			manifest,
			expectedBundle: "/usr/local/libexec/buncargo/hostsd-6.1.0.js",
			fileExists: () => true,
		});
		expect(message).toContain("hostsd-6.0.0.js");
		expect(message).toContain("hostsd-6.1.0.js");
		expect(message).toContain("buncargo hosts install");
	});

	it("says nothing when the installed bundle is the current one", () => {
		expect(
			describeStaleService({
				installed: true,
				manifest,
				expectedBundle: manifest.args[0],
				fileExists: () => true,
			}),
		).toBeUndefined();
	});

	// The path stops at the version, so a rebuild at the same version passed
	// every other check here — which is how a machine ran days-old daemon code
	// while `doctor` reported the service current.
	it("flags a bundle rebuilt at the same version", () => {
		const message = describeStaleService({
			installed: true,
			manifest: { ...manifest, bundleHash: "aaaaaaaaaaaaaaaa" },
			expectedBundle: manifest.args[0],
			expectedBundleHash: "bbbbbbbbbbbbbbbb",
			fileExists: () => true,
		});
		expect(message).toContain("buncargo hosts install");
	});

	it("says nothing when the bundle contents match", () => {
		expect(
			describeStaleService({
				installed: true,
				manifest: { ...manifest, bundleHash: "aaaaaaaaaaaaaaaa" },
				expectedBundle: manifest.args[0],
				expectedBundleHash: "aaaaaaaaaaaaaaaa",
				fileExists: () => true,
			}),
		).toBeUndefined();
	});

	// A manifest written before the field, or a CLI installed without `dist/`,
	// must not report every command as stale.
	it("says nothing when either side cannot be hashed", () => {
		expect(
			describeStaleService({
				installed: true,
				manifest,
				expectedBundle: manifest.args[0],
				expectedBundleHash: "bbbbbbbbbbbbbbbb",
				fileExists: () => true,
			}),
		).toBeUndefined();
		expect(
			describeStaleService({
				installed: true,
				manifest: { ...manifest, bundleHash: "aaaaaaaaaaaaaaaa" },
				expectedBundle: manifest.args[0],
				fileExists: () => true,
			}),
		).toBeUndefined();
	});
});

describe.skipIf(!hostsServicePath())("installHostsService", () => {
	const servicePath = hostsServicePath() ?? "";
	// Injected so install does not depend on a built `dist/hostsd.js`.
	const bundle = { contents: "// daemon\n", version: "9.9.9" };
	const bundlePath = "/usr/local/libexec/buncargo/hostsd-9.9.9.js";

	it("writes the unit file, loads it, then records the manifest", () => {
		const { runner, calls, files } = recordingRunner();
		installHostsService({ user, runner, bundle });

		expect(files.has(servicePath)).toBe(true);
		expect(commandNames(calls)[0]).toBe("authorize");
		expect(commandNames(calls)).toContain("writeFile");
		expect(commandNames(calls)).toContain(isDarwin ? "launchctl" : "systemctl");

		const manifest = readHostsServiceManifest();
		expect(manifest?.args).toEqual([bundlePath]);
	});

	// launchd cannot read a root daemon's entrypoint out of ~/Documents, and a
	// path in node_modules disappears on the next install, so the bundle has to
	// land in a root-owned directory before the unit file points at it.
	it("installs the daemon bundle into the root-owned directory first", () => {
		const { runner, calls, files } = recordingRunner();
		installHostsService({ user, runner, bundle });

		expect(files.has(bundlePath)).toBe(true);
		const written = calls
			.filter((call) => call.command === "writeFile")
			.map((call) => call.args[0]);
		expect(written).toEqual([bundlePath, servicePath]);
		expect(calls).toContainEqual({
			command: "mkdir",
			args: ["-p", "/usr/local/libexec/buncargo"],
		});
	});

	it("rolls back the bundle as well when the service fails to load", () => {
		const { runner, files } = recordingRunner({ failOn: activateFails });

		expect(() => installHostsService({ user, runner, bundle })).toThrow(
			HOSTS_SERVICE_START_MESSAGE,
		);

		expect(files.has(bundlePath)).toBe(false);
		expect(files.has(servicePath)).toBe(false);
	});

	it("removes the installed bundle on uninstall", () => {
		writeHostsServiceManifest({ program: "/bin/bun", args: [bundlePath] });
		const { runner, calls } = recordingRunner();

		uninstallHostsService({ runner });

		expect(calls).toContainEqual({ command: "removeFile", args: [bundlePath] });
	});

	// The manifest lives in the user's home, so a tampered entry must not turn
	// uninstall into an arbitrary root delete.
	it("refuses to remove a manifest path outside the managed directory", () => {
		writeHostsServiceManifest({ program: "/bin/bun", args: ["/etc/passwd"] });
		const { runner, calls } = recordingRunner();

		uninstallHostsService({ runner });

		expect(
			calls.filter((call) => call.command === "removeFile"),
		).not.toContainEqual({ command: "removeFile", args: ["/etc/passwd"] });
	});

	it.skipIf(!isDarwin)(
		"waits for the old job to unload before bootstrapping",
		() => {
			// bootout returns before the job is gone; bootstrapping while it is
			// still on its way out fails with EBUSY.
			let printed = 0;
			const { runner, calls } = recordingRunner({
				stillLoaded: () => ++printed < 3,
			});

			installHostsService({ user, runner, bundle });

			const launchctl = calls
				.filter((call) => call.command === "launchctl")
				.map((call) => call.args[0]);
			expect(launchctl[0]).toBe("bootout");
			expect(launchctl.at(-1)).toBe("bootstrap");
			expect(launchctl.filter((arg) => arg === "print").length).toBe(3);
		},
	);

	it("rolls back the unit file when it fails to load", () => {
		const { runner, calls, files } = recordingRunner({ failOn: activateFails });

		expect(() => installHostsService({ user, runner, bundle })).toThrow(
			HOSTS_SERVICE_START_MESSAGE,
		);

		// A leftover unit file would make isHostsServiceInstalled() report a
		// service that never loaded, and every later run would skip setup.
		expect(files.has(servicePath)).toBe(false);
		expect(commandNames(calls)).toContain("removeFile");
		expect(readHostsServiceManifest()).toBeUndefined();
	});

	it("unloads the service on uninstall even when the unit file is gone", () => {
		writeHostsServiceManifest({ program: "/bin/bun", args: ["/x/bin.js"] });
		const { runner, calls } = recordingRunner();

		uninstallHostsService({ runner });

		expect(commandNames(calls)).toContain(isDarwin ? "launchctl" : "systemctl");
		expect(readHostsServiceManifest()).toBeUndefined();
	});

	// Only meaningful on a machine with no service installed; this asserts we do
	// not prompt for a password when there is nothing to remove.
	it.skipIf(isHostsServiceInstalled())(
		"does nothing when neither a unit file nor a manifest exists",
		() => {
			const { runner, calls } = recordingRunner();
			uninstallHostsService({ runner });
			expect(calls).toEqual([]);
		},
	);
});
