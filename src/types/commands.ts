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
	boolean | { ok: boolean; detail?: string; severity?: "error" | "warning" };

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

/**
 * What `buncargo typecheck` checks beyond the workspaces it discovers (the
 * root `package.json` `workspaces`, else `apps/*`, `packages/*`, `modules`,
 * each with a `typecheck` script).
 */
export interface TypecheckConfig {
	/**
	 * More directories to check, relative to the root; globs allowed. For a
	 * directory discovery cannot see: a root `scripts/`, a package outside
	 * `workspaces`. Each runs its `typecheck` script when its `package.json`
	 * has one, else `tsc --noEmit -p tsconfig.json` with the project's own
	 * TypeScript. An entry that matches no directory, or a directory with
	 * neither, fails the check rather than being skipped.
	 */
	include?: readonly string[];
	/**
	 * Workspaces to leave out: paths relative to the root, globs, or a bare
	 * name matching a workspace's basename (like `--only`).
	 */
	exclude?: readonly string[];
	/**
	 * Default `--concurrency` for `buncargo typecheck` and `buncargo check`.
	 * `BUNCARGO_TYPECHECK_CONCURRENCY` outranks it, so a CI runner can size
	 * itself. Unset: from the CPU count (cap 4 locally, by memory in CI).
	 */
	concurrency?: number;
	/**
	 * Named selections for `buncargo typecheck --group=<name>`, so CI can
	 * split the check across runners without listing every workspace.
	 */
	groups?: Record<string, TypecheckGroupConfig>;
	/**
	 * The `package.json` scripts that check a workspace, each its own job in
	 * the pool (`["typecheck", "typecheck:e2e"]`). A workspace is discovered
	 * when it has any of them and runs the ones it has. Default:
	 * `["typecheck"]`.
	 */
	scripts?: readonly string[];
}

/** One `typecheck.groups` entry. */
export interface TypecheckGroupConfig {
	/** Only these workspaces (path or basename), like `--only`. */
	only?: readonly string[];
	/** Leave these out, on top of `typecheck.exclude`. */
	exclude?: readonly string[];
	/** Also check the root dev config. Default: true. */
	rootConfig?: boolean;
}

/**
 * A project check `buncargo check` runs beside Biome, the typecheck and the
 * tests, such as a codegen drift check or an import-boundary lint.
 */
export interface CheckGateConfig {
	/** Shown in the step line: `✓ <name> 1.2s`. */
	name: string;
	/** Shell command, run from `cwd`. */
	command: string;
	/** Relative to the monorepo root. Default: the root. */
	cwd?: string;
	/**
	 * Globs of changed files that select the gate (`apps/web/**`, `**\/*.md`).
	 * A change to a root manifest, lockfile, tsconfig or the dev config
	 * selects every gate. Unset: always runs. `check --all` runs every gate.
	 */
	when?: readonly string[];
	/** Also run in `check --staged` (the pre-commit hook). Default: true. */
	staged?: boolean;
	/**
	 * Selected by a change to a root manifest, lockfile, tsconfig or the dev
	 * config, as well as by `when`. Default: true.
	 */
	rootWide?: boolean;
	/**
	 * Shell command that repairs what the gate reports (`bun run gen`). In
	 * the default changed-files mode a failing gate runs it from `cwd` and
	 * checks again; `--staged` and `--all` only report.
	 */
	fix?: string;
}

/**
 * One `check.testAlso` entry: tests that guard files they do not sit next
 * to, such as an integration test over a whole folder.
 */
export interface CheckTestAlsoConfig {
	/** Globs of changed files that select the tests. */
	when: readonly string[];
	/** The test files to run: paths or globs relative to the root. */
	tests: readonly string[];
}

/**
 * `check.testDeferred`: tests `check` selects but does not run, because
 * they need services (a database, a queue). They are listed with the
 * command that runs them, and the verdict counts them.
 */
export interface CheckTestDeferredConfig {
	/** Globs of the test files to leave out (`**\/*.database.test.ts`). */
	files: readonly string[];
	/**
	 * The command the files are passed to, shown for running them by hand or
	 * in CI (`bunx buncargo ci -- bun test`). Default: `check.testCommand`.
	 */
	command?: string;
	/** Fail the check when it leaves a test out. Default: false. */
	strict?: boolean;
}

/** `buncargo check`: one command for the change in front of you. */
export interface CheckConfig {
	/** Project checks, in order, after the typecheck. */
	gates?: readonly CheckGateConfig[];
	/**
	 * The test runner the tests next to changed files are passed to.
	 * Default: `bun test`.
	 */
	testCommand?: string;
	/** Globs of test files never run by `check` (e2e suites). */
	testExclude?: readonly string[];
	/** Tests a change selects beyond the ones next to the changed files. */
	testAlso?: readonly CheckTestAlsoConfig[];
	/** Selected tests that need services: listed, not run. */
	testDeferred?: CheckTestDeferredConfig;
	/**
	 * Format with `bun fmt` before Biome: the changed files (written), the
	 * staged ones (`--check`), the whole repo with `--all` (`--check`). `true`
	 * formats every file bun fmt knows; globs (`["**\/*.{ts,tsx,vue}"]`) limit
	 * it. `.prettierignore` still applies. Needs Bun 1.4.4. Default: off.
	 */
	format?: boolean | readonly string[];
	/**
	 * Check relative Markdown links and documented commands. Default: true.
	 * `{ paths: true }` also checks backticked repository paths.
	 */
	docs?: boolean | DocsCheckConfig;
}

/** `check.docs` as an object: the docs check with its opt-in parts. */
export interface DocsCheckConfig {
	/**
	 * Report a backticked path whose first segment is a directory at the root
	 * (`apps/api/src/index.ts`) and that exists neither from the root nor from
	 * the doc's own folder, extensionless module paths and gitignored outputs
	 * included. Default: false.
	 */
	paths?: boolean | DocPathsCheckConfig;
}

export interface DocPathsCheckConfig {
	/** Paths meant not to exist, such as a worked example or another repo's file. */
	exempt?: readonly DocPathExemption[];
}

export interface DocPathExemption {
	/** Glob of the docs it applies to; `**` for every doc. */
	file: string;
	/** The exact backticked path. Unset: every path in those docs. */
	path?: string;
	/** Why the path is meant to be missing. */
	reason: string;
}

/** What a {@link PredeployConfig} hook is handed. */
export interface PredeployContext {
	/** Monorepo root. */
	root: string;
	/** The deploy environment's name (`staging`, `production`, a PR branch). */
	environment: string;
	production: boolean;
	/** Run a shell command from the root (or `cwd`); throws on a nonzero exit. */
	exec: (command: string, options?: { cwd?: string }) => Promise<void>;
}

/**
 * `buncargo predeploy`: the one-off step a host (Railway, Fly) runs before
 * each deploy. It applies migrations (`prisma` and `migrations`) and runs
 * `seed.command` outside production, with the deploy's own environment.
 */
export interface PredeployConfig {
	/**
	 * Variables naming the deploy environment, first set wins.
	 * Default: `["SECRETS_ENV", "NODE_ENV"]`. With none set the environment is
	 * `dev`, and it is not seeded: a deploy that names nothing is not known to
	 * be a throwaway one.
	 */
	environmentVars?: readonly string[];
	/** Environment names that are never seeded. Default: `["prod", "production"]`. */
	production?: readonly string[];
	/**
	 * The only environment names that are seeded, e.g. `["staging", "preview"]`.
	 * Default: every named environment outside `production`.
	 */
	seedIn?: readonly string[];
	/**
	 * What to seed outside production: a command, run from the root (a
	 * deploy's database is remote, so its seeder may need other flags), or
	 * `true` for the dev run's `seed.command`. Default: nothing is seeded.
	 */
	seed?: true | string;
	/**
	 * Retry a migration whose output contains `match`: a small Postgres
	 * refuses connections while the previous deploy's pool still holds its
	 * slots, and waiting frees them. Default: Postgres's "remaining connection
	 * slots are reserved" (SQLSTATE 53300), 20 attempts 15 s apart. `false`
	 * fails on the first refusal.
	 */
	retry?: false | { match?: string; attempts?: number; delayMs?: number };
	beforeMigrate?: (ctx: PredeployContext) => void | Promise<void>;
	afterMigrate?: (ctx: PredeployContext) => void | Promise<void>;
	/** After seeding, or after migrations when nothing was seeded. */
	afterSeed?: (ctx: PredeployContext) => void | Promise<void>;
	/**
	 * When a step fails, before `predeploy` exits nonzero: to alert someone,
	 * or to record the failure. What it throws is printed and the deploy
	 * still fails.
	 */
	onFailure?: (
		ctx: PredeployContext,
		failure: PredeployFailure,
	) => void | Promise<void>;
}

/** What {@link PredeployConfig.onFailure} is told about the failed step. */
export interface PredeployFailure {
	step: "beforeMigrate" | "migrate" | "afterMigrate" | "seed" | "afterSeed";
	/** The migration's `name`, when `step` is `migrate`. */
	migration?: string;
	/** The error `predeploy` prints. */
	message: string;
	/**
	 * The migration Prisma recorded as failed (P3009, P3018). Every later
	 * deploy stops at it until `prisma migrate resolve` runs.
	 */
	failedPrismaMigration?: string;
}

/** A named app selection for `buncargo dev --profile=<name>`. */
export interface ProfileConfig<TAppKey extends string = string> {
	/** Apps to run, plus their `requiredApps`, exactly like `--apps`. */
	apps: readonly TAppKey[];
	description?: string;
}
