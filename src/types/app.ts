import type { ComputedPorts, ComputedUrls } from "./computed";
import type {
	EnvValues,
	EnvVarsBuilder,
	EnvVarsContext,
	OverlayEnvVarNames,
} from "./config";
import type { ServiceConfig } from "./service";

// ═══════════════════════════════════════════════════════════════════════════
// App Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for an application (e.g., api, web).
 */
interface AppOptions<TStatic extends EnvValues = EnvValues> {
	/**
	 * Opt into public URLs with --expose.
	 * @deprecated frp sharing automatically includes all selected endpoints with a host port.
	 * This option only controls public tunnels started with --expose.
	 */
	expose?: boolean;
	/** Protocol for recipient sharing; apps default to HTTP, presets infer it, custom services default to TCP. */
	exposeProtocol?: "http" | "tcp";
	/** Command to start the dev server. Set to false to reserve/tunnel the port without starting a process. */
	devCommand: string | false;
	/** Command to start production server (optional) */
	prodCommand?: string;
	/** Command to build for production (optional) */
	buildCommand?: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Health check endpoint path (e.g., '/api/health'). Set to false to skip readiness wait. */
	healthEndpoint?: string | false;
	/** Timeout for health check in milliseconds */
	healthTimeout?: number;
	/** Service keys that must be running when this app starts */
	requiredServices?: readonly string[];
	/**
	 * App keys that must also start when this app starts. Selection only: they
	 * start in the same wave, not first. Use `startAfter` for ordering.
	 */
	requiredApps?: readonly string[];
	/**
	 * Spawn only once these apps are healthy (a worker: spawned and alive).
	 * Also selects them, like `requiredApps`. Holds in every mode, not just
	 * the `--expose` waves.
	 */
	startAfter?: readonly string[];
	/**
	 * Values to pick out of this app's output (stdout and stderr, ANSI and
	 * box-drawing stripped), by name. See {@link CaptureConfig}.
	 */
	captures?: Readonly<Record<string, CaptureConfig>>;
	/**
	 * Restart this app when one of these values changes after it started:
	 * `captured.<name>` or `publicUrls.<app>`.
	 */
	restartOn?: readonly string[];
	/**
	 * A command run to completion before `devCommand` starts, e.g. a one-off
	 * build whose output the watcher and other tools need to exist.
	 */
	prebuild?: string;
	/**
	 * A resource only one run on the machine may use at a time, e.g.
	 * `"shopify-app:<client_id>"`. A second run is refused (or, with
	 * `--takeover`, stops the holder's app and takes the lease).
	 */
	exclusive?: string;
	/** Constant env vars injected only into this app's own processes */
	staticEnv?: TStatic;
	/**
	 * Fetch this app's Infisical secrets once, in buncargo, and inject them.
	 * Merged below the developer's own environment and below computed env vars.
	 * Set false to skip this app, including startup prefetch.
	 */
	secrets?: SecretsScopeConfig | false;
	/** Own the TTY (stdin). Only one app may be interactive. Ignored by the TUI. */
	interactive?: boolean;
	/**
	 * Whether the run ends when this app exits. Default: true. With `false` the
	 * other apps keep going: the app shows as stopped with its exit code, and
	 * `r` in the TUI (or `buncargo restart <app>`) starts it again. It never
	 * holds startup up: it is health-checked on the side.
	 */
	essential?: boolean;
	/**
	 * Single keys that open one of this app's captured URLs, shown in the TUI
	 * footer once the capture has a value (`buncargo open <app> <capture>` does
	 * the same from anywhere). Keys must be unique and not one of buncargo's.
	 */
	actions?: readonly AppAction[];
	/** Start this app after public tunnels are open so env sees *_PUBLIC_URL. */
	needsPublicUrls?: boolean;
	/** Computed env vars injected only into this app's own processes */
	envVars?: (...args: never[]) => EnvValues;
	/**
	 * An Expo dev server: gets `RCT_METRO_PORT`, and `buncargo sim` opens it in
	 * a per-checkout iOS simulator. Inferred when `devCommand` mentions `expo`.
	 * @deprecated Use `integrations: [expo({ apps: { name: options } })]` from `buncargo/expo`.
	 */
	expo?: boolean | ExpoAppOptions;
}

/** A key that opens a captured URL: `{ key: "p", label: "open preview", open: "previewUrl" }`. */
export interface AppAction {
	/** One character. */
	key: string;
	label: string;
	/** The name of one of this app's `captures`. */
	open: string;
}

/**
 * One value to capture from an app's output.
 *
 * `publicUrl` sets `publicUrls.<app>` / `<APP>_PUBLIC_URL`, exactly like a
 * tunnel URL (normalized to its origin). `value` is `captured.<name>` in hooks,
 * `envVars`, generated files and `buncargo env --get captured.<name>`. `event`
 * only fires `onCapture`. Every kind fires `onCapture` and lands in the run
 * registry.
 */
export interface CaptureConfig {
	/** The first capture group is the value; without one, the whole match. */
	pattern: RegExp;
	as: "publicUrl" | "value" | "event";
	/**
	 * Show the value under this label in `buncargo env`, `buncargo url` / `open`,
	 * the run registry and BuncargoBar.
	 */
	label?: string;
	/** Also set this env var to the value, beneath the config's own `env`. */
	env?: string;
}

/**
 * Where an app's secrets live in Infisical.
 *
 * Declared per app; `secrets` at the config level supplies the fields every
 * app shares. Buncargo fetches each distinct scope once per dev run and hands
 * the values to the child processes, so the apps' own loaders never spawn the
 * Infisical CLI — concurrent CLI processes hang.
 */
export interface SecretsScopeConfig {
	/** Infisical project id. Required, here or in the config-level defaults. */
	projectId?: string;
	/**
	 * Infisical organization the project belongs to. A CLI session is scoped
	 * to it per fetch, so projects in different organizations run side by side
	 * without `infisical switch`.
	 */
	organizationId?: string;
	/** Environment slug. Default: `SECRETS_ENV`, else `"dev"`. */
	environment?: string;
	/** Infisical origin. Default: `https://eu.infisical.com`, like hanzio. */
	siteUrl?: string;
	/** Folder, matching the app's own secret path. Default: `"/"`. */
	path?: string;
	/**
	 * Keys that must be present after the fetch. A missing one stops the app
	 * before it spawns, naming the key, instead of the app crashing on it.
	 */
	required?: readonly string[];
}

/** A long-running owned process. Readiness means spawned and still alive. */
export type WorkerAppConfig<TStatic extends EnvValues = EnvValues> =
	AppOptions<TStatic> & {
		kind: "worker";
		devCommand: string;
		port?: never;
		expose?: never;
		healthEndpoint?: never;
		expo?: never;
	};
export type AppConfig<TStatic extends EnvValues = EnvValues> =
	| (AppOptions<TStatic> & { kind?: "server"; port: number })
	| WorkerAppConfig<TStatic>;

export interface ExpoAppOptions {
	/** Deep-link scheme of the development build. Default: `scheme` in app.json, else `exp+<slug>`. */
	scheme?: string;
	/** Simulator each checkout's device is cloned from. Default: the one last used in Simulator.app. */
	simulator?: string;
}

/**
 * The `staticEnv` object a service or app declared.
 *
 * Widens to {@link EnvValues} when nothing was declared, which
 * {@link OverlayEnvVarNames} then reads as "no extra keys".
 */
export type DeclaredStaticEnv<T> = "staticEnv" extends keyof T
	? NonNullable<T["staticEnv"]>
	: EnvValues;

/**
 * The object an app's own `envVars` builder returns.
 *
 * Widens to {@link EnvValues} when the app declares no builder or the builder's
 * return was already erased, so callers get "no extra keys" rather than an error.
 */
export type DeclaredAppEnvVars<TApp> = "envVars" extends keyof TApp
	? NonNullable<TApp["envVars"]> extends (...args: never[]) => infer TReturn
		? [TReturn] extends [EnvValues]
			? TReturn
			: EnvValues
		: EnvValues
	: EnvValues;

/**
 * `TApps` with every position that names a service or app key narrowed to this
 * config's own keys.
 *
 * The `envVars` parameters are spelled out with `NoInfer` rather than reused
 * from {@link EnvVarsBuilder}: a builder that reads `ports.web` would otherwise
 * make `TApps` an inference target from inside the very object it is inferred
 * from, and TypeScript resolves that circularity by falling back to the
 * `Record<string, AppConfig>` constraint — losing every app key. The return type
 * is carried over from the app's own declaration so `buildAppEnvVars` can see it.
 *
 * The `never` branch keeps the no-apps instantiation (`Record<string, never>`)
 * assignable to `Record<string, AppConfig>`; rewriting `never` would otherwise
 * drop the required `port` / `devCommand` members.
 */
type AppDefinitionBase<T extends AppConfig> = T extends AppConfig
	? Omit<T, "requiredServices" | "requiredApps" | "envVars">
	: never;

export type TypedAppDefinitions<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TApps]: [TApps[K]] extends [never]
		? TApps[K]
		: AppDefinitionBase<TApps[K]> & {
				requiredServices?: readonly Extract<keyof TServices, string>[];
				requiredApps?: readonly Extract<keyof TApps, string>[];
				startAfter?: readonly Extract<keyof TApps, string>[];
				envVars?: (
					ports: NoInfer<
						ComputedPorts<TServices, TypedAppDefinitions<TServices, TApps>>
					>,
					urls: NoInfer<
						ComputedUrls<TServices, TypedAppDefinitions<TServices, TApps>>
					>,
					ctx: NoInfer<
						EnvVarsContext<TServices, TypedAppDefinitions<TServices, TApps>>
					>,
				) => DeclaredAppEnvVars<TApps[K]>;
			};
};
