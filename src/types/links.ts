/**
 * Cross-repo linking types: a checkout links to another buncargo repo's live
 * run (`links: { backend: { project: "kanpla-backend", path: "../backend" } }`)
 * and reads its URLs, ports, captures and non-secret exported env vars without
 * sharing a config, port block or Git worktree.
 */

/** A link declaration in `DevConfig.links`. */
export interface LinkConfig {
	/**
	 * The linked repo's `projectPrefix` (as declared in its `dev.config.ts` and
	 * recorded in `~/.buncargo/runs.json`).
	 */
	project: string;
	/**
	 * Optional default checkout path relative to this repo's root (e.g.
	 * `"../backend"`). Used for actionable hints and doctor diagnostics; never
	 * silently resolves ambiguity when multiple checkouts of `project` are live.
	 */
	path?: string;
	/**
	 * Require this linked repo to be running when starting (`buncargo dev`,
	 * `env.start()`). Default: `false` (optional link; `ctx.links.<name>` is
	 * `undefined` when not running, allowing fallback to cloud/Infisical values).
	 */
	required?: boolean;
	/**
	 * App names expected on the linked run. Missing or failed/stopped apps are
	 * reported by `buncargo links`, `status`, `doctor`, and fail startup when
	 * `required: true`.
	 */
	apps?: readonly string[];
	/**
	 * Service names expected on the linked run. Checked alongside `apps`.
	 */
	services?: readonly string[];
	/**
	 * What this checkout's running apps do when this link comes up, goes down,
	 * or changes its URLs/ports/exports while `buncargo dev` is running.
	 * - `"ignore"` (default): only apps listing `"links.<alias>"` in `restartOn` restart.
	 * - `"restart"`: every running app in this checkout restarts with fresh env.
	 */
	onChange?: "restart" | "ignore";
	/**
	 * Profile to pass (`--profile=<name>`) when `buncargo dev --with-links`
	 * starts this linked repo.
	 */
	profile?: string;
}

/** A resolved link config after active profile overrides are applied. */
export interface ResolvedLinkConfig extends LinkConfig {
	/** Set when the active profile explicitly disabled this link (`false`). */
	disabled?: boolean;
}

/** Per-profile override for one configured link (`profiles.<name>.links.<alias>`). */
export type ProfileLinkOverride =
	| false
	| {
			required?: boolean;
			apps?: readonly string[];
			services?: readonly string[];
			onChange?: "restart" | "ignore";
			profile?: string;
	  };

/**
 * Live state of one linked checkout, exposed on `ctx.links.<name>` and
 * `env.links.<name>`.
 */
export interface ResolvedLink {
	/** The linked repo's `projectPrefix`. */
	readonly project: string;
	/** The linked checkout's Compose project name (includes worktree suffix). */
	readonly projectName: string;
	/** Absolute path to the linked checkout root (e.g. for `MONO_REPO_PATH`). */
	readonly root: string;
	/** Worktree directory name, or `null` in the main checkout. */
	readonly worktree: string | null;
	/** Current Git branch of the linked checkout, when recorded. */
	readonly branch?: string;
	/** Allocated ports of the linked run's live apps and services, by name. */
	readonly ports: Readonly<Record<string, number>>;
	/** Preferred URLs of the linked run's apps and services (named HTTPS when active, else loopback). */
	readonly urls: Readonly<Record<string, string>>;
	/** `http://localhost:<port>` / loopback URLs of the linked run's apps and services. */
	readonly loopbackUrls: Readonly<Record<string, string>>;
	/** Public tunnel or captured public URLs of the linked run's apps and services. */
	readonly publicUrls: Readonly<Record<string, string>>;
	/** Non-secret captures published by the linked run's apps. */
	readonly captured: Readonly<Record<string, string>>;
	/**
	 * Non-secret env vars exported by the linked run (e.g. Firebase emulator
	 * hosts and project IDs from `buncargo/firebase`, plus any keys listed in
	 * the linked config's `exportEnv`).
	 */
	readonly env: Readonly<Record<string, string>>;
	/** Live app statuses on the linked run, by app name. */
	readonly appStatuses: Readonly<Record<string, string>>;
	/** Live service statuses on the linked run, by service name. */
	readonly serviceStatuses: Readonly<Record<string, string>>;
}

/**
 * Map of configured link aliases to their live {@link ResolvedLink}, or
 * `undefined` when the linked repo is not running, ambiguous, or disabled.
 */
export type ResolvedLinks<
	TLinks extends Record<string, LinkConfig> = Record<string, LinkConfig>,
> = {
	readonly [K in Extract<keyof TLinks, string>]: ResolvedLink | undefined;
};

/** One running checkout of a linked project (used when multiple checkouts are live). */
export interface LinkCandidate {
	readonly root: string;
	readonly projectName: string;
	readonly worktree: string | null;
	readonly branch?: string;
}

/** Resolution outcome for a single configured link. */
export type LinkStatusKind =
	"linked" | "not-running" | "ambiguous" | "missing-endpoints" | "disabled";

/** Full diagnostic record for one configured link (`buncargo links`, `status`, `doctor`). */
export interface LinkInspection {
	readonly name: string;
	readonly project: string;
	readonly status: LinkStatusKind;
	readonly required: boolean;
	/** How the target checkout was chosen. */
	readonly source: "pinned" | "auto" | "none";
	/** Path pinned via `buncargo links pin`, when set. */
	readonly pinnedRoot?: string;
	/** Whether the pinned path is confirmed deleted on disk. */
	readonly pinMissing?: boolean;
	/** Actual running `projectPrefix` at `pinnedRoot` when it does not match `project`. */
	readonly pinProjectMismatch?: string;
	/** Resolved configured default `path` relative to this checkout root, when set. */
	readonly configuredPath?: string;
	/** Resolved target checkout root (linked run's root, pinned root, or configured default path). */
	readonly targetRoot?: string;
	/** Live link data when connected (`linked` or `missing-endpoints`). */
	readonly link?: ResolvedLink;
	/** Declared `apps` missing or stopped/failed on the linked run. */
	readonly missingApps: readonly string[];
	/** Declared `services` missing or stopped on the linked run. */
	readonly missingServices: readonly string[];
	/** Live checkouts matching `project` when `status === "ambiguous"`. */
	readonly candidates: readonly LinkCandidate[];
}
