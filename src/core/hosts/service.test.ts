import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getServiceManifestPath } from "./paths";
import type { PrivilegedRunner } from "./privileged";
import { HOSTS_PROTOCOL, MIN_HOSTS_PROTOCOL } from "./protocol";
import {
	describeStaleService,
	HOSTS_SERVICE_START_MESSAGE,
	type HostsServiceManifest,
	hostsServicePath,
	installHostsService,
	isHostsServiceInstalled,
	missingServiceTargets,
	readHostsServiceManifest,
	SYSTEMD_UNIT,
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
		/** Root-owned files already on disk, by path. */
		files?: Iterable<[string, string]>;
		failWrite?: (path: string) => boolean;
	} = {},
): {
	runner: PrivilegedRunner;
	calls: RecordedCall[];
	files: Map<string, string>;
} {
	const calls: RecordedCall[] = [];
	const files = new Map<string, string>(options.files);
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
		writeFile(path, contents) {
			calls.push({ command: "writeFile", args: [path] });
			if (options.failWrite?.(path)) throw new Error(`cp ${path}: EACCES`);
			files.set(path, contents);
		},
		removeFile(path) {
			calls.push({ command: "removeFile", args: [path] });
			files.delete(path);
		},
		readFile: (path) => files.get(path),
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

const manifest: HostsServiceManifest = {
	version: 2,
	protocol: HOSTS_PROTOCOL,
	buncargoVersion: "6.0.0",
	program: "/opt/homebrew/bin/bun",
	args: ["/usr/local/libexec/buncargo/hostsd-6.0.0.js"],
	installedAt: new Date().toISOString(),
};

describe("service manifest", () => {
	it("round-trips what the service was installed with, and its protocol", () => {
		writeHostsServiceManifest({
			program: "/opt/homebrew/bin/bun",
			args: ["/usr/local/libexec/buncargo/hostsd-6.0.0.js"],
			buncargoVersion: "6.0.0",
		});
		expect(readHostsServiceManifest()).toEqual({
			...manifest,
			installedAt: expect.any(String),
		});
	});

	it("reads as absent when the file is missing", () => {
		expect(readHostsServiceManifest()).toBeUndefined();
	});

	// What every machine has until `hosts install` runs: it reads as a service
	// to update, not one this CLI can judge.
	it("reads a manifest from before the protocol as absent", async () => {
		await Bun.write(
			getServiceManifestPath(),
			JSON.stringify({
				version: 1,
				program: "/bin/bun",
				args: ["/usr/local/libexec/buncargo/hostsd-15.1.0.js"],
				bundleHash: "abc123",
			}),
		);
		expect(readHostsServiceManifest()).toBeUndefined();
	});

	// Read as absent, a later format sent an older project to repair it, which
	// downgraded the newer project's daemon.
	it("reads a later format by the fields it keeps", async () => {
		await Bun.write(
			getServiceManifestPath(),
			JSON.stringify({ ...manifest, version: 3, protocol: 7, extra: true }),
		);
		expect(readHostsServiceManifest()).toMatchObject({
			protocol: 7,
			buncargoVersion: "6.0.0",
		});
	});
});

describe("missingServiceTargets", () => {
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
	it("says nothing when no service is installed", () => {
		expect(
			describeStaleService({ installed: false, manifest: undefined }),
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

	// A unit removed by hand, or a reinstall that failed with nothing to put
	// back, read as a machine that never had the service.
	it("flags a manifest whose unit file is gone", () => {
		expect(
			describeStaleService({
				installed: false,
				manifest,
				fileExists: () => true,
			}),
		).toContain("unit file is gone");
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

	// Two projects on two releases share the one daemon. Calling "different"
	// stale had each prompt to reinstall over the other on every run.
	it("says nothing for another release at a protocol this CLI can use", () => {
		for (const installed of [
			{ ...manifest, buncargoVersion: "1.0.0" },
			{ ...manifest, buncargoVersion: "99.0.0", protocol: HOSTS_PROTOCOL + 1 },
		]) {
			expect(
				describeStaleService({
					installed: true,
					manifest: installed,
					fileExists: () => true,
				}),
			).toBeUndefined();
		}
	});

	it("flags a service below this CLI's minimum protocol", () => {
		const message = describeStaleService({
			installed: true,
			manifest: { ...manifest, protocol: MIN_HOSTS_PROTOCOL - 1 },
			fileExists: () => true,
		});
		expect(message).toContain(`protocol ${MIN_HOSTS_PROTOCOL - 1}`);
		expect(message).toContain("buncargo hosts install");
	});
});

describe.skipIf(!hostsServicePath())("installHostsService", () => {
	const servicePath = hostsServicePath() ?? "";
	// Injected so install does not depend on a built `dist/hostsd.js`.
	const bundle = { contents: "// daemon\n", version: "9.9.9" };
	const bundlePath = "/usr/local/libexec/buncargo/hostsd-9.9.9.js";

	// An older project accepting the update prompt took the newer project's
	// daemon away and dropped every proxied websocket on the machine.
	/** What another project's `hosts install` left on the machine. */
	function installedBy(installed: Partial<HostsServiceManifest>): void {
		const path = getServiceManifestPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ ...manifest, ...installed }));
	}

	it("keeps a newer service and asks for nothing", () => {
		for (const newer of [
			{ buncargoVersion: "10.0.0" },
			{ buncargoVersion: "9.0.0", protocol: HOSTS_PROTOCOL + 1 },
		]) {
			installedBy(newer);
			const { runner, calls } = recordingRunner();

			const result = installHostsService({ user, runner, bundle });

			expect(result.kept).toContain(`buncargo ${newer.buncargoVersion}`);
			expect(calls).toEqual([]);
			expect(readHostsServiceManifest()).toMatchObject(newer);
		}
	});

	it("replaces an older release or the same one", () => {
		for (const buncargoVersion of ["9.0.0", "9.9.9"]) {
			installedBy({ buncargoVersion });
			const { runner } = recordingRunner();

			expect(installHostsService({ user, runner, bundle })).toEqual({});
			expect(readHostsServiceManifest()?.buncargoVersion).toBe("9.9.9");
		}
	});

	it("installs over a newer service when forced", () => {
		installedBy({ buncargoVersion: "10.0.0" });
		const { runner } = recordingRunner();

		expect(installHostsService({ user, runner, bundle, force: true })).toEqual(
			{},
		);
		expect(readHostsServiceManifest()?.buncargoVersion).toBe("9.9.9");
	});

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
		writeHostsServiceManifest({
			program: "/bin/bun",
			args: [bundlePath],
			buncargoVersion: "9.9.9",
		});
		const { runner, calls } = recordingRunner();

		uninstallHostsService({ runner });

		expect(calls).toContainEqual({ command: "removeFile", args: [bundlePath] });
	});

	// The manifest lives in the user's home, so a tampered entry must not turn
	// uninstall into an arbitrary root delete.
	it("refuses to remove a manifest path outside the managed directory", () => {
		writeHostsServiceManifest({
			program: "/bin/bun",
			args: ["/etc/passwd"],
			buncargoVersion: "9.9.9",
		});
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

	// `start` and `enable --now` are no-ops on an active unit, so a reinstall
	// left the old code running while the manifest said the new code was.
	it.skipIf(isDarwin)(
		"restarts the unit so a reinstall runs the new code",
		() => {
			const { runner, calls } = recordingRunner();
			installHostsService({ user, runner, bundle });

			const systemctl = calls
				.filter((call) => call.command === "systemctl")
				.map((call) => call.args.join(" "));
			expect(systemctl).toContain(`restart ${SYSTEMD_UNIT}`);
			expect(systemctl).not.toContain(`enable --now ${SYSTEMD_UNIT}`);
		},
	);

	// On a same-version reinstall the bundle path is the old service's own;
	// deleting it, and the unit, left the machine with no service at all.
	it("puts the previous unit and bundle back when a reinstall fails to load", () => {
		let activations = 0;
		const { runner, files } = recordingRunner({
			files: [
				[servicePath, "old unit"],
				[bundlePath, "// old daemon\n"],
			],
			failOn: (command, args) => {
				if (!activateFails(command, args)) return false;
				activations += 1;
				return activations === 1;
			},
		});

		expect(() => installHostsService({ user, runner, bundle })).toThrow(
			HOSTS_SERVICE_START_MESSAGE,
		);

		expect(files.get(servicePath)).toBe("old unit");
		expect(files.get(bundlePath)).toBe("// old daemon\n");
		expect(activations).toBe(2);
	});

	it("removes the bundle it wrote when the unit cannot be written", () => {
		const { runner, files } = recordingRunner({
			failWrite: (path) => path === servicePath,
		});

		expect(() => installHostsService({ user, runner, bundle })).toThrow(
			"admin rights",
		);

		expect(files.has(bundlePath)).toBe(false);
		expect(files.has(servicePath)).toBe(false);
	});

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
		writeHostsServiceManifest({
			program: "/bin/bun",
			args: ["/x/bin.js"],
			buncargoVersion: "9.9.9",
		});
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
