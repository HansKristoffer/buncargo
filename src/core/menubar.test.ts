import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type BarFolders,
	type BarRelease,
	type BundleCopy,
	downloadBarRelease,
	getBarManifestPath,
	installDirectory,
	readBarManifest,
	readBundleInfo,
	readInstalledBarInfo,
	removeInstalledBars,
	replaceBundle,
} from "./menubar";
import { useTempHome } from "./test-env.testing";

/**
 * Reading a bundle's identity out of its own `Info.plist`.
 *
 * This is what decides whether an installed app can read this CLI's registry,
 * so a parse that quietly returns `undefined` would turn a required update into
 * silence. The plist shape here is copied from `menubar/scripts/package.sh`.
 */
const home = useTempHome();

/** The install folders, with `system` standing in for `/Applications`. */
function folders(system: string): BarFolders {
	return { system, user: join(home(), "Applications") };
}

function writeBundle(
	path: string,
	options: { version?: string; registryVersion?: number } = {},
): string {
	mkdirSync(join(path, "Contents"), { recursive: true });
	const keys = [
		options.version === undefined
			? ""
			: `\t<key>CFBundleShortVersionString</key>\n\t<string>${options.version}</string>`,
		options.registryVersion === undefined
			? ""
			: `\t<key>BuncargoRegistryVersion</key>\n\t<integer>${options.registryVersion}</integer>`,
	].filter(Boolean);
	writeFileSync(
		join(path, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>BuncargoBar</string>\n${keys.join("\n")}\n</dict>\n</plist>\n`,
	);
	return path;
}

describe("readBundleInfo", () => {
	it("reads the version and the registry version a build stamped", () => {
		const bundle = writeBundle(join(home(), "BuncargoBar.app"), {
			version: "0.4.0",
			registryVersion: 2,
		});
		expect(readBundleInfo(bundle)).toEqual({
			path: bundle,
			version: "0.4.0",
			registryVersion: 2,
		});
	});

	// Every bundle released before the key existed decodes v1. Reading those as
	// "unknown" would mean either nagging them forever or never updating them.
	it("assumes v1 for a bundle built before the key existed", () => {
		const bundle = writeBundle(join(home(), "Old.app"), { version: "0.1.0" });
		expect(readBundleInfo(bundle).registryVersion).toBe(1);
	});

	it("survives a missing or unreadable plist", () => {
		const bundle = join(home(), "Broken.app");
		mkdirSync(bundle, { recursive: true });
		expect(readBundleInfo(bundle)).toEqual({
			path: bundle,
			registryVersion: 1,
		});
	});
});

describe("readInstalledBarInfo", () => {
	it("follows the manifest to a bundle outside the standard locations", () => {
		const bundle = writeBundle(join(home(), "custom", "BuncargoBar.app"), {
			version: "1.2.3",
			registryVersion: 7,
		});
		mkdirSync(join(home(), ".buncargo"), { recursive: true });
		writeFileSync(
			getBarManifestPath(),
			JSON.stringify({
				version: 1,
				path: bundle,
				appVersion: "1.2.3",
				installedAt: new Date().toISOString(),
			}),
		);
		expect(readInstalledBarInfo()).toEqual({
			path: bundle,
			version: "1.2.3",
			registryVersion: 7,
		});
	});
});

describe("readBarManifest", () => {
	// The manifest is a file in the user's home: what it says is read, not
	// trusted, and a field of the wrong shape is left out.
	it("keeps only the fields that check out", () => {
		mkdirSync(join(home(), ".buncargo"), { recursive: true });
		const manifest = {
			version: 1,
			path: "/Applications/BuncargoBar.app",
			appVersion: "1.2.3",
			installedAt: "2026-11-11T00:00:00.000Z",
		};
		writeFileSync(
			getBarManifestPath(),
			JSON.stringify({ ...manifest, cli: { program: 1 }, extra: true }),
		);
		expect(readBarManifest()).toEqual(manifest);
	});
});

describe("installDirectory", () => {
	it("installs into the system directory when it is writable", () => {
		expect(installDirectory(folders(home()))).toBe(home());
	});

	it.skipIf(process.getuid?.() === 0)(
		"falls back to ~/Applications when the system directory is read-only",
		() => {
			const system = join(home(), "system");
			mkdirSync(system, { mode: 0o555 });
			expect(installDirectory(folders(system))).toBe(
				join(home(), "Applications"),
			);
		},
	);

	it("updates a copy in place where its folder is writable", () => {
		// Installed to ~/Applications earlier; /Applications became writable since.
		const existing = writeBundle(
			join(home(), "Applications", "BuncargoBar.app"),
		);
		expect(installDirectory(folders(home()), existing)).toBe(
			join(home(), "Applications"),
		);
	});
});

describe("removeInstalledBars", () => {
	it("removes every copy, including the second one an update left", () => {
		const system = join(home(), "system");
		const systemCopy = writeBundle(join(system, "BuncargoBar.app"));
		const userCopy = writeBundle(
			join(home(), "Applications", "BuncargoBar.app"),
		);
		mkdirSync(join(home(), ".buncargo"), { recursive: true });
		writeFileSync(
			getBarManifestPath(),
			JSON.stringify({
				version: 1,
				path: userCopy,
				appVersion: "1.2.3",
				installedAt: new Date().toISOString(),
			}),
		);

		expect(removeInstalledBars(folders(system))).toBe(true);
		expect(existsSync(systemCopy)).toBe(false);
		expect(existsSync(userCopy)).toBe(false);
		expect(existsSync(getBarManifestPath())).toBe(false);
		expect(removeInstalledBars(folders(system))).toBe(false);
	});
});

describe("replaceBundle", () => {
	/** A copy that does what `ditto` does, or fails as a full disk would. */
	const copy =
		(fails: boolean): BundleCopy =>
		(from, to) => {
			if (fails) return { ok: false, error: "No space left on device" };
			cpSync(from, to, { recursive: true });
			return { ok: true };
		};

	it("keeps the installed app when the new one cannot be copied", () => {
		// The installed copy was removed before the copy, so a failed one left
		// no app at all.
		const target = writeBundle(
			join(home(), "Applications", "BuncargoBar.app"),
			{
				version: "1.0.0",
			},
		);
		const source = writeBundle(join(home(), "incoming", "BuncargoBar.app"), {
			version: "2.0.0",
		});

		expect(() => replaceBundle(source, target, copy(true))).toThrow(
			"No space left on device",
		);
		expect(readBundleInfo(target).version).toBe("1.0.0");
		expect(readdirSync(join(home(), "Applications"))).toEqual([
			"BuncargoBar.app",
		]);
	});

	it("puts the installed app back when the swap fails", () => {
		// A copy that reports success with nothing staged: the swap's rename
		// throws after the installed app was moved aside, which left no app.
		const target = writeBundle(
			join(home(), "Applications", "BuncargoBar.app"),
			{
				version: "1.0.0",
			},
		);
		const source = writeBundle(join(home(), "incoming", "BuncargoBar.app"), {
			version: "2.0.0",
		});

		expect(() => replaceBundle(source, target, () => ({ ok: true }))).toThrow(
			"ENOENT",
		);
		expect(readBundleInfo(target).version).toBe("1.0.0");
		expect(readdirSync(join(home(), "Applications"))).toEqual([
			"BuncargoBar.app",
		]);
	});

	it("swaps the new app in and leaves nothing beside it", () => {
		const target = writeBundle(
			join(home(), "Applications", "BuncargoBar.app"),
			{
				version: "1.0.0",
			},
		);
		const source = writeBundle(join(home(), "incoming", "BuncargoBar.app"), {
			version: "2.0.0",
		});

		replaceBundle(source, target, copy(false));

		expect(readBundleInfo(target).version).toBe("2.0.0");
		expect(readdirSync(join(home(), "Applications"))).toEqual([
			"BuncargoBar.app",
		]);
	});
});

describe("downloadBarRelease", () => {
	const release: BarRelease = {
		tag: "bar-v1.0.0",
		version: "1.0.0",
		zipUrl: "https://downloads.example/BuncargoBar.zip",
		checksumUrl: "https://downloads.example/BuncargoBar.zip.sha256",
	};
	const checksumOf = (payload: string) =>
		new Response(
			`${createHash("sha256").update(payload).digest("hex")}  BuncargoBar.zip\n`,
		);

	it("stops the download when the run's signal fires", async () => {
		const run = new AbortController();
		const to = join(home(), "bar.zip");
		let cancelled = false;
		await expect(
			downloadBarRelease(release, to, {
				signal: run.signal,
				fetch: async (url) =>
					url === release.checksumUrl
						? checksumOf("the app")
						: new Response(
								new ReadableStream(
									{
										// The first chunk arrives, then the run ends.
										pull(stream) {
											stream.enqueue(new Uint8Array([1]));
											run.abort(new Error("the run ended"));
										},
										cancel() {
											cancelled = true;
										},
									},
									{ highWaterMark: 0 },
								),
							),
			}),
		).rejects.toThrow("the run ended");
		expect(cancelled).toBe(true);
		expect(readdirSync(home())).toEqual([]);
	});

	it("refuses a zip that does not match the published checksum", async () => {
		const to = join(home(), "bar.zip");
		await expect(
			downloadBarRelease(release, to, {
				signal: new AbortController().signal,
				fetch: async (url) =>
					url === release.checksumUrl
						? checksumOf("the app")
						: new Response("something else"),
			}),
		).rejects.toThrow("checksum did not match");
		expect(readdirSync(home())).toEqual([]);
	});
});
