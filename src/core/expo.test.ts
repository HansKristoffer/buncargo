import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chooseLaunchUrl,
	describeExpoApp,
	isExpoApp,
	pickSourceDevice,
	simulatorDeviceName,
} from "./expo";

describe("isExpoApp", () => {
	it("infers from the dev command and honours an explicit flag", () => {
		expect(isExpoApp({ devCommand: "bunx expo start" })).toBe(true);
		expect(isExpoApp({ devCommand: "bun run dev" })).toBe(false);
		expect(isExpoApp({ devCommand: "bun run dev", expo: true })).toBe(true);
		expect(isExpoApp({ devCommand: "bunx expo start", expo: false })).toBe(
			false,
		);
		expect(isExpoApp(undefined)).toBe(false);
	});
});

describe("describeExpoApp", () => {
	it("reads scheme and bundle id from app.json, config scheme winning", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-expo-"));
		writeFileSync(
			join(root, "app.json"),
			JSON.stringify({
				expo: {
					slug: "lullu",
					scheme: ["lullu", "com.lullu"],
					ios: { bundleIdentifier: "com.lullu.app" },
				},
			}),
		);
		expect(describeExpoApp(root, { devCommand: "bunx expo start" })).toEqual({
			scheme: "lullu",
			bundleId: "com.lullu.app",
		});
		expect(
			describeExpoApp(root, {
				devCommand: "bunx expo start",
				expo: { scheme: "other", simulator: "iPhone 17" },
			}),
		).toEqual({
			scheme: "other",
			bundleId: "com.lullu.app",
			simulator: "iPhone 17",
		});
	});

	it("falls back to exp+slug, and to nothing without app.json", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-expo-"));
		writeFileSync(
			join(root, "app.json"),
			JSON.stringify({ expo: { slug: "x" } }),
		);
		expect(describeExpoApp(root, { devCommand: "bunx expo start" })).toEqual({
			scheme: "exp+x",
		});
		expect(
			describeExpoApp(root, { devCommand: "bunx expo start", cwd: "nope" }),
		).toEqual({});
		expect(
			describeExpoApp(root, { devCommand: "bun run dev" }),
		).toBeUndefined();
	});
});

describe("chooseLaunchUrl", () => {
	const expo = { scheme: "lullu", bundleId: "com.lullu.app" };
	it("prefers the installed development build, then Expo Go", () => {
		expect(
			chooseLaunchUrl({
				port: 8181,
				expo,
				installed: new Set(["com.lullu.app", "host.exp.Exponent"]),
			}),
		).toBe(
			"lullu://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8181",
		);
		expect(
			chooseLaunchUrl({
				port: 8181,
				expo,
				installed: new Set(["host.exp.Exponent"]),
			}),
		).toBe("exp://127.0.0.1:8181");
		expect(
			chooseLaunchUrl({ port: 8181, expo, installed: new Set() }),
		).toBeUndefined();
	});
	it("trusts a configured scheme when app.json named no build", () => {
		expect(
			chooseLaunchUrl({
				port: 8181,
				expo: { scheme: "lullu" },
				installed: new Set(),
			}),
		).toContain("lullu://");
		expect(
			chooseLaunchUrl({ port: 8181, expo: {}, installed: new Set() }),
		).toBeUndefined();
	});
});

describe("simulator devices", () => {
	const devices = [
		{
			udid: "A",
			name: "iPad Air",
			state: "Shutdown",
			deviceTypeIdentifier: "x.iPad-Air",
		},
		{
			udid: "B",
			name: "iPhone 16 Pro",
			state: "Shutdown",
			deviceTypeIdentifier: "x.iPhone-16-Pro",
		},
		{
			udid: "C",
			name: "lullu/fix-ui · iPhone 16 Pro",
			state: "Booted",
			deviceTypeIdentifier: "x.iPhone-16-Pro",
		},
	];
	it("names the clone after the checkout and the source's base model", () => {
		expect(simulatorDeviceName("lullu/main", "iPhone 16 Pro")).toBe(
			"lullu/main · iPhone 16 Pro",
		);
		// Cloning a buncargo clone must not stack labels.
		expect(
			simulatorDeviceName("lullu/main", "lullu/fix-ui · iPhone 16 Pro"),
		).toBe("lullu/main · iPhone 16 Pro");
	});
	it("picks the configured, then last-used, then first iPhone", () => {
		expect(pickSourceDevice(devices, { simulator: "iPad Air" }).udid).toBe("A");
		expect(pickSourceDevice(devices, { lastUsed: "C" }).udid).toBe("C");
		expect(pickSourceDevice(devices, { lastUsed: "nope" }).udid).toBe("B");
		expect(() => pickSourceDevice(devices, { simulator: "iPhone 3G" })).toThrow(
			/No simulator named/,
		);
	});
});
