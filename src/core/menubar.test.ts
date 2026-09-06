import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getBarManifestPath,
	readBundleInfo,
	readInstalledBarInfo,
} from "./menubar";

/**
 * Reading a bundle's identity out of its own `Info.plist`.
 *
 * This is what decides whether an installed app can read this CLI's registry,
 * so a parse that quietly returns `undefined` would turn a required update into
 * silence. The plist shape here is copied from `menubar/scripts/package.sh`.
 */
let home: string;
const realHome = process.env.HOME;

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

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-bar-info-"));
	process.env.HOME = home;
});

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

describe("readBundleInfo", () => {
	it("reads the version and the registry version a build stamped", () => {
		const bundle = writeBundle(join(home, "BuncargoBar.app"), {
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
		const bundle = writeBundle(join(home, "Old.app"), { version: "0.1.0" });
		expect(readBundleInfo(bundle).registryVersion).toBe(1);
	});

	it("survives a missing or unreadable plist", () => {
		const bundle = join(home, "Broken.app");
		mkdirSync(bundle, { recursive: true });
		expect(readBundleInfo(bundle)).toEqual({
			path: bundle,
			registryVersion: 1,
		});
	});
});

describe("readInstalledBarInfo", () => {
	it("follows the manifest to a bundle outside the standard locations", () => {
		const bundle = writeBundle(join(home, "custom", "BuncargoBar.app"), {
			version: "1.2.3",
			registryVersion: 7,
		});
		mkdirSync(join(home, ".buncargo"), { recursive: true });
		writeFileSync(
			getBarManifestPath(),
			JSON.stringify({
				version: 1,
				path: bundle,
				appVersion: "1.2.3",
				installedAt: new Date().toISOString(),
			}),
		);
		expect(readInstalledBarInfo(home)).toEqual({
			path: bundle,
			version: "1.2.3",
			registryVersion: 7,
		});
	});
});
