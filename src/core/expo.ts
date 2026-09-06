import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../types";
import { isTcpPortOpen } from "./network";
import { sleep } from "./sleep";

/**
 * Expo apps, and the iOS simulator that shows one per checkout.
 *
 * Expo Go and a development build are shells: the JavaScript comes from
 * whichever Metro a deep link names. Two worktrees are therefore two Metro
 * ports plus two simulator devices, one per worktree, each opened on its own
 * `exp://127.0.0.1:<port>`. A device is created by cloning the one the user
 * already works in, so the development build installed there comes along;
 * the name records which checkout it belongs to, so the next `sim` finds it.
 *
 * The launch URL mirrors Expo CLI's own choice: the development build when it
 * is installed on the device, else Expo Go. `simctl openurl` exits 0 for a
 * scheme nothing handles, so this is decided from `simctl listapps` rather
 * than from the exit code.
 */

/** What `buncargo sim` needs, resolved once at publish time into the run registry. */
export interface ExpoAppIdentity {
	/** Deep-link scheme of the development build, `exp+<slug>` when the app declares none. */
	scheme?: string;
	/** `ios.bundleIdentifier`, when app.json declares it. */
	bundleId?: string;
	/** Simulator to clone the per-checkout device from. */
	simulator?: string;
}

const EXPO_GO_BUNDLE_ID = "host.exp.Exponent";
const METRO_WAIT_MS = 60_000;

type ExpoAppLike = Pick<AppConfig, "devCommand" | "cwd" | "expo">;

export function isExpoApp(config: ExpoAppLike | undefined): boolean {
	if (!config) return false;
	if (config.expo !== undefined) return config.expo !== false;
	return (
		typeof config.devCommand === "string" && /\bexpo\b/.test(config.devCommand)
	);
}

export function describeExpoApp(
	root: string,
	config: ExpoAppLike | undefined,
): ExpoAppIdentity | undefined {
	if (!config || !isExpoApp(config)) return undefined;
	const options = typeof config.expo === "object" ? config.expo : {};
	const app = readAppJson(resolve(root, config.cwd ?? "."));
	const declared = Array.isArray(app.scheme) ? app.scheme[0] : app.scheme;
	const scheme =
		options.scheme ??
		(typeof declared === "string" ? declared : undefined) ??
		(typeof app.slug === "string" ? `exp+${app.slug}` : undefined);
	const bundleId = app.ios?.bundleIdentifier;
	return {
		...(scheme ? { scheme } : {}),
		...(typeof bundleId === "string" ? { bundleId } : {}),
		...(options.simulator ? { simulator: options.simulator } : {}),
	};
}

interface AppJson {
	slug?: unknown;
	scheme?: unknown;
	ios?: { bundleIdentifier?: unknown };
}

/** `app.json` only: `app.config.ts` needs evaluating, and `expo.scheme` covers that case. */
function readAppJson(dir: string): AppJson {
	try {
		const parsed = JSON.parse(readFileSync(resolve(dir, "app.json"), "utf-8"));
		return (parsed?.expo ?? parsed ?? {}) as AppJson;
	} catch {
		return {};
	}
}

/** Which app on the device gets the deep link. */
export function chooseLaunchUrl(input: {
	port: number;
	expo: ExpoAppIdentity;
	installed: ReadonlySet<string>;
}): string | undefined {
	const { port, expo, installed } = input;
	const metro = `http://127.0.0.1:${port}`;
	const devClient = expo.scheme
		? `${expo.scheme}://expo-development-client/?url=${encodeURIComponent(metro)}`
		: undefined;
	if (expo.bundleId && installed.has(expo.bundleId)) return devClient;
	if (installed.has(EXPO_GO_BUNDLE_ID)) return `exp://127.0.0.1:${port}`;
	// No app.json to name the build: trust the configured scheme.
	if (!expo.bundleId) return devClient;
	return undefined;
}

/** `<project>/<worktree> · iPhone 16 Pro`: the title Simulator.app shows. */
export function simulatorDeviceName(label: string, source: string): string {
	return `${label} · ${source.split(" · ").pop() ?? source}`;
}

export interface SimulatorDevice {
	udid: string;
	name: string;
	state: string;
	deviceTypeIdentifier: string;
}

function simctl(args: string[]): string {
	return execFileSync("xcrun", ["simctl", ...args], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function listDevices(): SimulatorDevice[] {
	const parsed = JSON.parse(simctl(["list", "devices", "available", "-j"])) as {
		devices: Record<string, SimulatorDevice[]>;
	};
	return Object.values(parsed.devices).flat();
}

/** The device Simulator.app last showed, which is where the development build tends to live. */
function lastUsedDeviceUdid(): string | undefined {
	try {
		return execFileSync(
			"defaults",
			["read", "com.apple.iphonesimulator", "CurrentDeviceUDID"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		return undefined;
	}
}

export function pickSourceDevice(
	devices: SimulatorDevice[],
	input: { simulator?: string; lastUsed?: string },
): SimulatorDevice {
	if (input.simulator) {
		const named = devices.find((device) => device.name === input.simulator);
		if (!named)
			throw new Error(
				`No simulator named "${input.simulator}". Run \`xcrun simctl list devices available\` to see them.`,
			);
		return named;
	}
	const lastUsed = devices.find((device) => device.udid === input.lastUsed);
	const fallback =
		lastUsed ??
		devices.find((device) => device.deviceTypeIdentifier.includes("iPhone"));
	if (!fallback) throw new Error("No iOS simulator is available.");
	return fallback;
}

function installedApps(udid: string): Set<string> {
	const matches = simctl(["listapps", udid]).matchAll(
		/CFBundleIdentifier = "([^"]+)"/g,
	);
	return new Set(Array.from(matches, (match) => match[1] as string));
}

export interface OpenSimulatorInput {
	/** `<projectPrefix>/<worktree|main>`, the checkout's half of the device name. */
	label: string;
	port: number;
	expo: ExpoAppIdentity;
	log?: (message: string) => void;
}

/** Boot this checkout's simulator, cloning it first if needed, and open the app on Metro. */
export async function openExpoSimulator(
	input: OpenSimulatorInput,
): Promise<{ url: string; device: string }> {
	const log = input.log ?? (() => {});
	const devices = listDevices();
	const source = pickSourceDevice(devices, {
		simulator: input.expo.simulator,
		lastUsed: lastUsedDeviceUdid(),
	});
	const name = simulatorDeviceName(input.label, source.name);
	let device = devices.find((entry) => entry.name === name);
	if (!device) {
		log(`Cloning "${source.name}" as "${name}"`);
		const udid = simctl(["clone", source.udid, name]).trim();
		device = { ...source, udid, name, state: "Shutdown" };
	}

	if (device.state !== "Booted") log(`Booting "${name}"`);
	// `-b` boots when needed and returns once the device is usable.
	simctl(["bootstatus", device.udid, "-b"]);
	execFileSync(
		"open",
		["-a", "Simulator", "--args", "-CurrentDeviceUDID", device.udid],
		{ stdio: "ignore" },
	);

	const deadline = Date.now() + METRO_WAIT_MS;
	let announced = false;
	while (!(await isTcpPortOpen(input.port))) {
		if (!announced) {
			log(`Waiting for Metro on :${input.port}`);
			announced = true;
		}
		if (Date.now() > deadline)
			throw new Error(`Metro did not start listening on :${input.port}.`);
		await sleep(500);
	}

	const url = chooseLaunchUrl({
		port: input.port,
		expo: input.expo,
		installed: installedApps(device.udid),
	});
	if (!url) {
		throw new Error(
			`Neither Expo Go nor the development build${input.expo.bundleId ? ` (${input.expo.bundleId})` : ""} is installed on "${name}".\n` +
				`   Install one: press shift+i in the Expo terminal and pick "${name}", or run \`npx expo run:ios --device "${name}"\`.`,
		);
	}
	simctl(["openurl", device.udid, url]);
	return { url, device: name };
}
