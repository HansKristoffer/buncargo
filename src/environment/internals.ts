import type { CapturedValue } from "../core/process/output-capture";
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
