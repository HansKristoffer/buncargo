import { canonicalCheckoutPath } from "./canonical-path";
import { readGitBranch } from "./git-branch";
import { type RunEntry, readLiveRunsSync } from "./run-registry-read";
import { siblingRunOverride } from "./runtime-flags";

/**
 * Lightweight, synchronous sibling-project run lookup via `~/.buncargo/runs.json`.
 *
 * Complements declarative `links` in `dev.config.ts`: callers in `env` or
 * `apps.<name>.envVars` can read a sibling repo's live app or service URL
 * directly (e.g. `lookupRunningApp("kanpla-backend", "core")?.loopbackUrl`) and
 * fall back to `undefined` when the sibling repo is not running.
 */

export interface RunningEndpoint {
	readonly name: string;
	readonly kind: "app" | "service";
	readonly projectPrefix: string;
	readonly projectName: string;
	readonly root: string;
	readonly worktree: string | null;
	readonly branch?: string;
	readonly profile?: string;
	readonly port: number;
	/** Named HTTPS URL when named hosts are active, else loopback URL. */
	readonly url: string;
	/** Always the loopback URL (`http://localhost:<port>` or service loopback URL). */
	readonly loopbackUrl: string;
	readonly publicUrl?: string;
	readonly status: string;
}

export interface LookupRunningOptions {
	/**
	 * Prefer a running sibling checkout on this Git branch when multiple
	 * checkouts of `projectPrefix` are active. Defaults to the current
	 * checkout's Git branch (read from `cwd`). Set `false` to disable branch
	 * preference and always pick the most recently started run.
	 */
	branch?: string | false;
	/** Match only a specific worktree name (`null` matches the main checkout). */
	worktree?: string | null;
	/** Match only a specific checkout directory path. */
	root?: string;
	/**
	 * Name of an environment variable whose value pins a sibling checkout by
	 * branch name, worktree name, `projectName`, or checkout path. When unset,
	 * `BUNCARGO_LINK_<PROJECT_PREFIX>` is checked automatically.
	 */
	overrideEnvVar?: string;
	/** Exclude runs from this checkout root (canonicalized). */
	excludeRoot?: string;
	/** Directory used to detect the current Git branch and resolve relative override paths. */
	cwd?: string;
	/** Only match ready/reused endpoints (default: `true`). Set `false` to also match `"starting"`. */
	readyOnly?: boolean;
}

interface CandidateCheckout {
	readonly root: string;
	readonly projectPrefix: string;
	readonly projectName: string;
	readonly worktree: string | null;
	readonly branch?: string;
	readonly profile?: string;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly endpoint: RunningEndpoint;
}

interface CheckoutMeta {
	readonly root: string;
	readonly projectPrefix: string;
	readonly projectName: string;
	readonly worktree: string | null;
	readonly branch?: string;
	readonly profile?: string;
}

function matchesSelector(
	candidate: CandidateCheckout,
	selector: string,
	cwd: string,
): boolean {
	if (
		candidate.branch === selector ||
		candidate.worktree === selector ||
		candidate.projectName === selector
	) {
		return true;
	}
	return candidate.root === canonicalCheckoutPath(selector, cwd);
}

/**
 * Extract one matching app or service endpoint from `run`. Returns `"unusable"`
 * when the run names `endpointName` in a non-usable state (e.g. stopped,
 * degraded) so a newer session overrides an earlier healthy one, or `"absent"`
 * when this session does not list it at all.
 */
function readEndpointFromRun(
	kind: "app" | "service",
	run: RunEntry,
	endpointName: string,
	meta: CheckoutMeta,
	readyOnly: boolean,
): RunningEndpoint | "absent" | "unusable" {
	const entry =
		kind === "app"
			? run.apps.find((item) => item.name === endpointName)
			: run.services.find((item) => item.name === endpointName);
	if (!entry) return "absent";

	if (
		entry.port === undefined ||
		entry.url === undefined ||
		entry.loopbackUrl === undefined
	) {
		return "absent";
	}

	const usable =
		kind === "app"
			? entry.status === "ready" ||
				entry.status === "reused" ||
				(!readyOnly && entry.status === "starting")
			: !("problem" in entry && entry.problem !== undefined) &&
				(entry.status === "ready" ||
					(!readyOnly && entry.status === "starting"));
	if (!usable) return "unusable";

	return {
		name: entry.name,
		kind,
		projectPrefix: meta.projectPrefix,
		projectName: meta.projectName,
		root: meta.root,
		worktree: meta.worktree,
		...(meta.branch !== undefined ? { branch: meta.branch } : {}),
		...(meta.profile !== undefined ? { profile: meta.profile } : {}),
		port: entry.port,
		url: entry.url,
		loopbackUrl: entry.loopbackUrl,
		...(entry.publicUrl !== undefined ? { publicUrl: entry.publicUrl } : {}),
		status: entry.status,
	};
}

function buildCheckoutCandidate(
	kind: "app" | "service",
	root: string,
	checkoutRuns: readonly RunEntry[],
	endpointName: string,
	worktreeFilter: string | null | undefined,
	readyOnly: boolean,
): CandidateCheckout | undefined {
	const ordered = [...checkoutRuns].sort((a, b) =>
		a.startedAt.localeCompare(b.startedAt),
	);
	const newest = ordered[ordered.length - 1];
	if (!newest) return undefined;

	if (worktreeFilter !== undefined && newest.worktree !== worktreeFilter) {
		return undefined;
	}

	const meta: CheckoutMeta = {
		root,
		projectPrefix: newest.projectPrefix,
		projectName: newest.projectName,
		worktree: newest.worktree,
		branch: ordered.findLast((run) => run.branch !== undefined)?.branch,
		profile: ordered.findLast((run) => run.profile !== undefined)?.profile,
	};

	let latestUpdatedAt = newest.updatedAt;
	let matched: RunningEndpoint | undefined;

	// Merge oldest-to-newest so multi-session checkouts (e.g. one run owning
	// services and another owning apps) expose every live endpoint.
	for (const run of ordered) {
		if (run.updatedAt > latestUpdatedAt) latestUpdatedAt = run.updatedAt;

		const result = readEndpointFromRun(
			kind,
			run,
			endpointName,
			meta,
			readyOnly,
		);
		if (result === "absent") continue;
		matched = result === "unusable" ? undefined : result;
	}

	if (!matched) return undefined;

	return {
		...meta,
		startedAt: newest.startedAt,
		updatedAt: latestUpdatedAt,
		endpoint: matched,
	};
}

/**
 * Pure sibling endpoint resolver over an explicit run snapshot and environment.
 * Used directly by unit tests and wrapped by {@link lookupRunningApp} and
 * {@link lookupRunningService}.
 */
export function resolveRunningEndpoint(
	kind: "app" | "service",
	projectPrefix: string,
	endpointName: string,
	input: LookupRunningOptions & {
		runs: readonly RunEntry[];
		env: NodeJS.ProcessEnv;
	},
): RunningEndpoint | undefined {
	if (!projectPrefix || !endpointName) return undefined;

	const cwd = input.cwd ?? process.cwd();
	const readyOnly = input.readyOnly ?? true;
	const excludedRoot =
		input.excludeRoot !== undefined
			? canonicalCheckoutPath(input.excludeRoot, cwd)
			: undefined;
	const requiredRoot =
		input.root !== undefined
			? canonicalCheckoutPath(input.root, cwd)
			: undefined;

	// Group non-ephemeral live runs of this project by canonical checkout root;
	// suffixed runs (`buncargo ci` / `withSuffix`) are throwaway and never linked.
	const byRoot = new Map<string, RunEntry[]>();
	for (const run of input.runs) {
		if (run.suffix !== undefined) continue;
		if (run.projectPrefix !== projectPrefix) continue;

		const canonical = canonicalCheckoutPath(run.root, cwd);
		if (excludedRoot !== undefined && canonical === excludedRoot) continue;
		if (requiredRoot !== undefined && canonical !== requiredRoot) continue;

		const list = byRoot.get(canonical);
		if (list) list.push(run);
		else byRoot.set(canonical, [run]);
	}

	const candidates: CandidateCheckout[] = [];
	for (const [root, checkoutRuns] of byRoot) {
		const candidate = buildCheckoutCandidate(
			kind,
			root,
			checkoutRuns,
			endpointName,
			input.worktree,
			readyOnly,
		);
		if (candidate) candidates.push(candidate);
	}

	if (candidates.length === 0) return undefined;

	const overrideValue = input.overrideEnvVar
		? input.env[input.overrideEnvVar]?.trim() || undefined
		: undefined;
	const explicitOverride =
		overrideValue ?? siblingRunOverride(projectPrefix, input.env);

	const filtered = explicitOverride
		? candidates.filter((candidate) =>
				matchesSelector(candidate, explicitOverride, cwd),
			)
		: candidates;

	if (filtered.length === 0) return undefined;
	if (filtered.length === 1) return filtered[0]?.endpoint;

	const preferredBranch =
		input.branch === false ? undefined : (input.branch ?? readGitBranch(cwd));

	const ranked = [...filtered].sort((a, b) => {
		if (preferredBranch !== undefined) {
			const aMatch = a.branch === preferredBranch ? 0 : 1;
			const bMatch = b.branch === preferredBranch ? 0 : 1;
			if (aMatch !== bMatch) return aMatch - bMatch;
		}
		const byStarted = b.startedAt.localeCompare(a.startedAt);
		if (byStarted !== 0) return byStarted;

		const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
		if (byUpdated !== 0) return byUpdated;

		return a.root.localeCompare(b.root);
	});

	return ranked[0]?.endpoint;
}

/**
 * Look up a live app endpoint of a sibling buncargo project from
 * `~/.buncargo/runs.json`.
 *
 * When multiple checkouts of `projectPrefix` are running, prefers one on the
 * same Git branch as the current checkout, then the most recently started run.
 * Set `options.overrideEnvVar` or `BUNCARGO_LINK_<PROJECT_PREFIX>` to pin a
 * specific branch, worktree name, `projectName`, or checkout path. Returns
 * `undefined` when no matching live run is active.
 */
export function lookupRunningApp(
	projectPrefix: string,
	appName: string,
	options?: LookupRunningOptions,
): RunningEndpoint | undefined {
	return resolveRunningEndpoint("app", projectPrefix, appName, {
		...options,
		runs: readLiveRunsSync(),
		env: process.env,
	});
}

/**
 * Look up a live service endpoint of a sibling buncargo project from
 * `~/.buncargo/runs.json`.
 *
 * Uses the same deterministic branch-first, newest-first, and override-env
 * resolution as {@link lookupRunningApp}. Returns `undefined` when no
 * matching live run is active.
 */
export function lookupRunningService(
	projectPrefix: string,
	serviceName: string,
	options?: LookupRunningOptions,
): RunningEndpoint | undefined {
	return resolveRunningEndpoint("service", projectPrefix, serviceName, {
		...options,
		runs: readLiveRunsSync(),
		env: process.env,
	});
}
