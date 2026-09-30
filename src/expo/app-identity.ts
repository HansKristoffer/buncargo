import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../types";

/** What `buncargo sim` needs, resolved once at publish time into the run registry. */
export interface ExpoAppIdentity {
	/** Deep-link scheme of the development build, `exp+<slug>` when the app declares none. */
	scheme?: string;
	/** `ios.bundleIdentifier`, when app.json declares it. */
	bundleId?: string;
	/** Simulator to clone the per-checkout device from. */
	simulator?: string;
}

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
