import { getErrorMessage } from "hanzio";
import { canonicalCheckoutPath } from "../../core/canonical-path";
import { unallocatedPortsMessage } from "../../core/port-exhaustion";
import { findMonorepoRoot } from "../../core/ports";
import { type RunEntry, readLiveRuns } from "../../core/run-registry";
import { portOffsetOverride } from "../../core/runtime-flags";
import type { AnyDevEnvironment } from "../../types";
import * as log from "../log";

function matchingCheckoutRuns(
	runs: readonly RunEntry[],
	root: string,
): RunEntry[] {
	const target = canonicalCheckoutPath(root);
	return runs
		.filter(
			(run) =>
				run.suffix === undefined && canonicalCheckoutPath(run.root) === target,
		)
		.sort(
			(a, b) =>
				a.startedAt.localeCompare(b.startedAt) ||
				a.updatedAt.localeCompare(b.updatedAt),
		);
}

/**
 * The active profile recorded on this checkout's newest live run, if any.
 * Ignores suffixed throwaway runs (`buncargo ci` / `withSuffix`).
 */
export function selectActiveRunProfile(
	runs: readonly RunEntry[],
	root: string,
): string | undefined {
	return matchingCheckoutRuns(runs, root).findLast(
		(run) => run.profile !== undefined,
	)?.profile;
}

/**
 * Live service and app ports recorded on this checkout's active runs, merged
 * oldest-to-newest so the newest run wins on overlap.
 */
export function collectActiveRunPorts(
	runs: readonly RunEntry[],
	root: string,
): Record<string, number> {
	const livePorts: Record<string, number> = {};
	for (const run of matchingCheckoutRuns(runs, root)) {
		for (const service of run.services) {
			if (service.port !== undefined && service.status !== "stopped") {
				livePorts[service.name] = service.port;
			}
		}
		for (const app of run.apps) {
			if (
				app.port !== undefined &&
				app.status !== "stopped" &&
				app.status !== "failed"
			) {
				livePorts[app.name] = app.port;
			}
		}
	}
	return livePorts;
}

/**
 * Load this checkout's environment as an active run sees it: inherits the
 * active run's profile when `--profile` is omitted, adopts its live ports,
 * active named hosts and captured values, and throws on config/profile errors.
 */
export async function loadCommandEnv(options?: {
	profile?: string;
	cwd?: string;
}): Promise<AnyDevEnvironment> {
	const [
		{ loadDevEnv },
		{ readLiveNamedUrls },
		{ adoptLiveCaptures },
		{ internalsOf },
	] = await Promise.all([
		import("../../loader"),
		import("../../core/checkout-view"),
		import("../../core/run-publish"),
		import("../../environment"),
	]);

	const cwd = options?.cwd ?? process.cwd();
	const checkoutRoot = findMonorepoRoot(cwd);

	let liveRuns: RunEntry[] = [];
	try {
		liveRuns = await readLiveRuns();
	} catch {
		// An unreadable runs.json should not block commands from falling back to config defaults.
	}

	const inheritedProfile =
		options?.profile === undefined
			? selectActiveRunProfile(liveRuns, checkoutRoot)
			: undefined;
	const effectiveProfile = options?.profile ?? inheritedProfile;

	let env: AnyDevEnvironment;
	try {
		env = await loadDevEnv({
			cwd,
			fresh: true,
			...(effectiveProfile !== undefined ? { profile: effectiveProfile } : {}),
		});
	} catch (error) {
		const isStaleInheritedProfile =
			options?.profile === undefined &&
			inheritedProfile !== undefined &&
			/^Unknown profile "/.test(getErrorMessage(error));
		if (!isStaleInheritedProfile) throw error;

		// Recorded profile was removed from dev.config.ts since the run started.
		env = await loadDevEnv({ cwd, fresh: true });
	}

	if (portOffsetOverride() === undefined) {
		const livePorts = collectActiveRunPorts(liveRuns, env.root);
		const matchingPorts = Object.fromEntries(
			Object.entries(livePorts).filter(([key]) =>
				Object.hasOwn(env.ports, key),
			),
		);
		if (Object.keys(matchingPorts).length > 0) {
			internalsOf(env).adoptLivePorts(matchingPorts);
		}
	}

	const live = env.hosts
		? readLiveNamedUrls(
				env.root,
				env.hosts.plan,
				env.ports as Record<string, number>,
			)
		: undefined;
	if (live) internalsOf(env).setNamedHostsActive(true, live);

	await adoptLiveCaptures(env, liveRuns);
	return env;
}

export async function loadEnv(options?: { profile?: string }) {
	try {
		return await (
			await import("../../loader")
		).loadDevEnv(
			options?.profile !== undefined ? { profile: options.profile } : undefined,
		);
	} catch (error) {
		log.fail(getErrorMessage(error));
	}
}

/**
 * The environment as this checkout's live run sees it: the active run's
 * profile and ports, the named URLs it serves, and what its apps printed.
 */
export async function loadLiveEnv(options?: { profile?: string }) {
	let env: AnyDevEnvironment;
	try {
		env = await loadCommandEnv(options);
	} catch (error) {
		log.fail(getErrorMessage(error));
	}

	// Answered all the same (`portOffsetProvenance: "unallocated"`): these
	// commands are how an agent finds its way out of a full range.
	if (env.portOffsetProvenance === "unallocated") {
		log.warn(unallocatedPortsMessage(env.root));
	}

	return env;
}
