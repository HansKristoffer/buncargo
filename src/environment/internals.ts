import type { PortOwner } from "../core/process";
import type { CapturedValue } from "../core/process/output-capture";
import type {
	ComposeDocument,
	NamedHostsActivation,
	PortOffsetProvenance,
	PreflightStep,
	SeedConfig,
	SetupCheck,
	TaskConfig,
} from "../types";
import type { AnyApps, AnyServices } from "./context";
import type { PrepareOptions } from "./lifecycle";
import type { AppPipeline, Prepared } from "./pipeline";
import type { StatusOutput } from "./status-output";

/**
 * What `buncargo dev` and the commands drive that a library user does not:
 * the start's phases one at a time, and the plumbing around them. Kept off
 * `DevEnvironment`, so the public type is what a script can rely on.
 */
export interface EnvironmentInternals extends AppPipeline {
	/** `start()` up to the apps: the run claimed, the services prepared. */
	prepare(options?: PrepareOptions): Promise<Prepared>;
	/** The Infisical session `prepare()` with these options needs, checked ahead of it. */
	secretsSession(options: PrepareOptions): Promise<void>;
	/**
	 * Where the run says a service's container stopping or recovering, and
	 * the watchdog failing to start. Default: stderr.
	 */
	notify(report: (message: string, problem: boolean) => void): void;
	/** Where its progress, and its own commands' output, go. Default: the terminal. */
	reportTo(output: StatusOutput): void;
	/** Render every generated file; returns the paths whose content changed. */
	renderGeneratedFiles(): string[];
	/**
	 * What `spawn()` does with a value an app printed: `captured` or
	 * `publicUrls`, `onCapture` hooks, generated files. Returns what changed.
	 */
	recordCapture(
		app: string,
		captured: CapturedValue,
	): Promise<readonly string[]>;
	/** Seed command from config, when present. */
	readonly seed?: Pick<
		SeedConfig<AnyServices, AnyApps>,
		"command" | "cwd" | "beforeApps" | "requiredServices"
	>;
	/** `setupChecks` from config and its integrations, run by `buncargo dev` before it starts anything. */
	readonly setupChecks?: readonly SetupCheck[];
	/** `preflight` from config and its integrations, run by `buncargo dev` with the terminal. */
	readonly preflight?: readonly PreflightStep[];
	/** `tasks` from config, for `buncargo run`. */
	readonly tasks?: Readonly<Record<string, TaskConfig<string, string>>>;
	/** Switch `urls` between localhost:port and named HTTPS hostnames. */
	setNamedHostsActive(active: boolean, extras?: NamedHostsActivation): void;
	/** Write the generated compose file when it is missing; returns the path passed to `-f`. */
	ensureComposeFile(): string;
	/** The service model the compose file is rendered from. */
	composeModel(): ComposeDocument;
	/**
	 * Where the next full `start()` would put the port block, without
	 * claiming or writing anything, asking `getOwner` who holds each port.
	 * `status` passes the reading it already took and compares the answer
	 * with `portOffset`, to warn before a run moves the ports.
	 */
	planPortOffset(getOwner: (port: number) => PortOwner | null): {
		offset: number;
		provenance: PortOffsetProvenance;
	};
}

const internals = new WeakMap<object, EnvironmentInternals>();

/** Attach an environment's internals; `createDevEnvironment` does it for each one. */
export function registerInternals(
	env: object,
	surface: EnvironmentInternals,
): void {
	internals.set(env, surface);
}

/** The internals of an environment `createDevEnvironment` made. */
export function internalsOf(env: object): EnvironmentInternals {
	const surface = internals.get(env);
	if (!surface)
		throw new Error(
			"This environment was not made by createDevEnvironment(); buncargo cannot drive it.",
		);
	return surface;
}
