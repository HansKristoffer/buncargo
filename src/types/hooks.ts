import type { AppConfig, SecretsScopeConfig } from "./app";
import type {
	ComputedLoopbackUrls,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
} from "./computed";
import type { ServiceConfig } from "./service";

// ═══════════════════════════════════════════════════════════════════════════
// Hooks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execution options for the exec helper.
 */
export interface ExecOptions {
	/** Select an app overlay and its default working directory. */
	app?: string;
	/**
	 * Infisical scope to inject, beneath everything else. Default: the app's
	 * `secrets`, else the config-level `secrets`. `false` injects none.
	 */
	secrets?: SecretsScopeConfig | false;
	/** Cancel the command and terminate its owned process group. */
	signal?: AbortSignal;
	/** Maximum execution time. Startup commands default to ten minutes; standalone exec has no default. */
	timeoutMs?: number;
	/** Grace before escalating termination. */
	killGraceMs?: number;
	/** Maximum combined stdout/stderr bytes before cancelling the process. */
	maxBufferBytes?: number;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Print output to console */
	verbose?: boolean;
	/** Environment variables to add */
	env?: Record<string, string>;
	/** Throw on non-zero exit code (default: true) */
	throwOnError?: boolean;
}

/**
 * Result of a command run through `exec`/`execAsync`.
 */
export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Context passed to hooks for executing commands and accessing environment.
 */
export interface HookContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	/** Selected names for this operation; requiredApps/Compose dependencies are expanded. */
	selectedApps?: readonly Extract<keyof TApps, string>[];
	selectedServices?: readonly Extract<keyof TServices, string>[];
	/** Cancellation for this startup operation; pass it to custom I/O. */
	signal?: AbortSignal;
	/** Project name (with suffix if applicable) */
	projectName: string;
	/** Computed ports for all services and apps */
	ports: ComputedPorts<TServices, TApps>;
	/** Computed URLs for all services and apps */
	urls: ComputedUrls<TServices, TApps>;
	/** `http://localhost:<port>` URLs, never rewritten by named hosts */
	loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	/** Public tunnel URLs for exposed services/apps (when active) */
	publicUrls: ComputedPublicUrls<TServices, TApps>;
	/** Execute a shell command with environment variables set */
	exec: (
		cmd: string | readonly string[],
		options?: ExecOptions,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Path to monorepo root */
	root: string;
	/** Whether running in CI environment */
	isCI: boolean;
	/** Port offset applied to all ports */
	portOffset: number;
	/** Local IP address for mobile connectivity */
	localIp: string;
	/** Values apps printed, by capture name (see `AppConfig.captures`). Empty until captured. */
	captured: Readonly<Record<string, string>>;
}

/** A value an app printed that matched one of its `captures`. */
export interface CaptureEvent {
	/** The app whose output matched. */
	app: string;
	/** The key in its `captures`. */
	name: string;
	value: string;
}

/**
 * Lifecycle hooks for customizing the dev environment.
 */
export interface DevHooks<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	/** After database readiness and before automatic/custom migrations. Skipped in containers-only mode. */
	beforeMigrations?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called after all containers are healthy and preparation has finished (legacy order). */
	afterContainersReady?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called before starting dev servers */
	beforeServers?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called after dev servers are ready */
	afterServers?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called before stopping the environment */
	beforeStop?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** An app printed a value one of its `captures` matched (every `as`). */
	onCapture?: (
		event: CaptureEvent,
		ctx: HookContext<TServices, TApps>,
	) => void | Promise<void>;
}
