import type { AppConfig, BuncargoIntegration, ExpoAppOptions } from "../types";
import { describeExpoApp, isExpoApp } from "./app-identity";

/**
 * `buncargo/expo`: Expo dev servers, one Metro port and one iOS simulator
 * device per checkout.
 *
 * ```ts
 * import { expo } from "buncargo/expo";
 * integrations: [expo({ apps: ["mobile"] })]
 * ```
 */

export interface ExpoIntegrationOptions {
	/**
	 * The Expo apps, by key, optionally with per-app options. Default: every app
	 * whose `devCommand` runs `expo`.
	 */
	apps?: readonly string[] | Readonly<Record<string, ExpoAppOptions | true>>;
}

export interface ExpoIntegration extends BuncargoIntegration {
	readonly name: "expo";
	/** Expo apps and their options, resolved when the config is applied. */
	appOptions(name: string): ExpoAppOptions | undefined;
}

function resolveExpoApps(
	apps: Record<string, AppConfig>,
	selected: ExpoIntegrationOptions["apps"],
): Map<string, ExpoAppOptions> {
	if (Array.isArray(selected)) {
		return new Map(selected.map((name) => [name, {}]));
	}
	if (selected) {
		return new Map(
			Object.entries(selected).map(([name, options]) => [
				name,
				options === true ? {} : options,
			]),
		);
	}
	return new Map(
		Object.entries(apps)
			.filter(([, app]) => isExpoApp(app))
			.map(([name]) => [name, {}]),
	);
}

export function expo(options: ExpoIntegrationOptions = {}): ExpoIntegration {
	let expoApps = new Map<string, ExpoAppOptions>();

	return {
		name: "expo",
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
			return { expo: describeExpoApp(root, config, appOptions) };
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
