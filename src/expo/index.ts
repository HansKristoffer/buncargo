import type { AppConfig, BuncargoIntegration, ExpoAppOptions } from "../types";
import { describeExpoApp, isExpoApp } from "./simulator";

/**
 * `buncargo/expo`: Expo dev servers, one Metro port and one iOS simulator
 * device per checkout.
 *
 * ```ts
 * import { expo } from "buncargo/expo";
 * integrations: [expo({ apps: ["mobile"], apiApp: "api" })]
 * ```
 */

export type { ExpoAppIdentity } from "./simulator";
export {
	chooseLaunchUrl,
	describeExpoApp,
	isExpoApp,
	openExpoSimulator,
	pickSourceDevice,
	simulatorDeviceName,
} from "./simulator";

export interface ExpoIntegrationOptions {
	/**
	 * The Expo apps, by key, optionally with per-app options. Default: every app
	 * whose `devCommand` runs `expo` (or that sets the deprecated `expo` field).
	 */
	apps?: readonly string[] | Readonly<Record<string, ExpoAppOptions | true>>;
	/** The app the Expo app calls; `getExpoApiUrl()` prints its LAN URL. Default: `api` */
	apiApp?: string;
}

export interface ExpoIntegration extends BuncargoIntegration {
	readonly name: "expo";
	readonly apiApp?: string;
	/** Expo apps and their options, resolved when the config is applied. */
	appOptions(name: string): ExpoAppOptions | undefined;
}

function resolveExpoApps(
	apps: Record<string, AppConfig>,
	selected: ExpoIntegrationOptions["apps"],
): Map<string, ExpoAppOptions> {
	// The deprecated per-app field still carries options for one major.
	const fieldOptions = (name: string): ExpoAppOptions => {
		const field = apps[name]?.expo;
		return typeof field === "object" ? field : {};
	};

	if (Array.isArray(selected)) {
		return new Map(selected.map((name) => [name, fieldOptions(name)]));
	}
	if (selected) {
		return new Map(
			Object.entries(selected).map(([name, options]) => [
				name,
				{ ...fieldOptions(name), ...(options === true ? {} : options) },
			]),
		);
	}
	return new Map(
		Object.entries(apps)
			.filter(([, app]) => isExpoApp(app))
			.map(([name]) => [name, fieldOptions(name)]),
	);
}

export function expo(options: ExpoIntegrationOptions = {}): ExpoIntegration {
	let expoApps = new Map<string, ExpoAppOptions>();

	return {
		name: "expo",
		apiApp: options.apiApp,
		appOptions: (name) => expoApps.get(name),

		config(config) {
			expoApps = resolveExpoApps(config.apps ?? {}, options.apps);
			for (const name of expoApps.keys()) {
				if (!config.apps?.[name]) {
					throw new Error(`expo(): "${name}" is not a configured app`);
				}
			}
			return config;
		},

		appEnv({ name, port, workspaceId }) {
			if (!expoApps.has(name)) return undefined;
			return {
				EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID: workspaceId,
				// Expo CLI ignores PORT; without this every worktree's Metro asks
				// for 8081 and the second one is offered 8082, not its own block.
				...(port === undefined ? {} : { RCT_METRO_PORT: String(port) }),
			};
		},

		describeApp({ name, config, root }) {
			const appOptions = expoApps.get(name);
			if (!appOptions) return undefined;
			return { expo: describeExpoApp(root, { ...config, expo: appOptions }) };
		},

		bannerHint: ({ name }) =>
			expoApps.has(name) ? "bunx buncargo sim" : undefined,

		commands: {
			sim: {
				summary: "Open this checkout's Expo app in its own iOS simulator",
				usage: "sim [<app>]",
				// Loaded on use: every config load builds this integration, and the
				// command pulls in the CLI's logging and the run registry.
				run: async ({ args }) =>
					(await import("./sim-command")).handleSim(args),
			},
		},
	};
}
