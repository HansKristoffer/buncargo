import type { AnyDevEnvironment } from "./environment";

// ═══════════════════════════════════════════════════════════════════════════
// Checks, Tasks and Profiles
// ═══════════════════════════════════════════════════════════════════════════

/** What a {@link SetupCheck} is handed. */
export interface CheckContext {
	/** Monorepo root; resolve relative paths against this. */
	root: string;
	/** The loaded environment: its apps, ports and `exec` in the checkout env. */
	env: AnyDevEnvironment;
}

/**
 * `true` passes; `{ ok: false, detail }` fails with a reason. `severity`
 * overrides the check's own for this result: a login that exists but has
 * expired is a warning, a missing one an error.
 */
export type CheckOutcome =
	| boolean
	| { ok: boolean; detail?: string; severity?: "error" | "warning" };

/**
 * A precondition of the checkout, such as generated code that has to exist.
 *
 * `buncargo dev` runs the fast ones before it starts anything and stops with
 * the fix instead of failing deep inside an app. `buncargo setup` and
 * `buncargo doctor` run all of them; `setup` offers each fix.
 */
export interface SetupCheck {
	/** Shown when the check fails, e.g. `'GraphQL types'`. */
	name: string;
	/** Return true when the checkout is ready. A check that throws has failed. */
	check: (ctx: CheckContext) => CheckOutcome | Promise<CheckOutcome>;
	/** A command run from the monorepo root, or a function for fixes that edit files. */
	fix?: string | ((ctx: CheckContext) => void | Promise<void>);
	/** What a function `fix` does, shown before asking to run it. */
	fixDescription?: string;
	/**
	 * Run on every `buncargo dev`. Default: true. Set false for anything that
	 * spawns a process or talks to a network; `setup` and `doctor` still run it.
	 */
	fast?: boolean;
	/** A warning is reported but never stops `dev` or fails `setup`. Default: error. */
	severity?: "error" | "warning";
}

/** What a {@link PreflightStep} is handed. */
export interface PreflightContext extends CheckContext {
	/**
	 * Whether a person is at the terminal: the step may prompt, open a browser
	 * or run an interactive login. False in CI, agents and piped output.
	 */
	interactive: boolean;
}

/**
 * A step `buncargo dev` runs before the TUI takes the screen, with the real
 * terminal, so it can prompt or open a browser: a login that would otherwise
 * fail half-way through the run. Throwing stops the start with its message,
 * like a failing check.
 */
export interface PreflightStep {
	name: string;
	/** Run only when one of these apps is selected. Default: always. */
	apps?: readonly string[];
	run(ctx: PreflightContext): void | Promise<void>;
}

/**
 * A named one-off script run with `buncargo run <name>`: the checkout env
 * (and `app`'s env and secrets), with `requiredServices` started first.
 */
export interface TaskConfig<
	// Keys rather than the service/app records: `keyof` would make this
	// contravariant in them, and a typed config would stop being an AnyDevConfig.
	TServiceKey extends string = string,
	TAppKey extends string = string,
> {
	/** Shell command. Arguments after `buncargo run <name> --` are appended. */
	command: string;
	/** One line for `buncargo run` and `buncargo help`. */
	description?: string;
	/** Use this app's env, secrets and default working directory. */
	app?: TAppKey;
	/** Working directory relative to the monorepo root. Default: the app's `cwd`, else the root. */
	cwd?: string;
	/** Started (with their Compose dependencies) when they are not running. */
	requiredServices?: readonly TServiceKey[];
}

/** What a generated file's `render` sees. */
export interface GeneratedFileContext {
	root: string;
	projectName: string;
	ports: Readonly<Record<string, number>>;
	urls: Readonly<Record<string, string>>;
	loopbackUrls: Readonly<Record<string, string>>;
	/** Tunnel and captured public URLs, by app/service; empty until known. */
	publicUrls: Readonly<Record<string, string | undefined>>;
	/** Values apps printed (`captures`); empty until captured. */
	captured: Readonly<Record<string, string>>;
	/** The process environment with the checkout's shared env on top. */
	env: Readonly<Record<string, string | undefined>>;
}

/**
 * A file buncargo keeps in sync with the run: rendered before servers start,
 * and again whenever what it reads changes (a capture, a tunnel URL, a port).
 * Written atomically, and only when the content changed, so watchers do not
 * rebuild for nothing.
 */
export interface GeneratedFileConfig {
	/** Relative to the monorepo root. */
	path: string;
	/** The whole file. Values not known yet should render a placeholder. */
	render: (ctx: GeneratedFileContext) => string;
	/** Should be gitignored; `doctor` and `setup` check that it is. */
	gitignore?: boolean;
}

/** A named app selection for `buncargo dev --profile=<name>`. */
export interface ProfileConfig<TAppKey extends string = string> {
	/** Apps to run, plus their `requiredApps`, exactly like `--apps`. */
	apps: readonly TAppKey[];
	description?: string;
}
