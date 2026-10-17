import type { ContainerRuntimeAdapter } from "../container-runtime";
import {
	explainContainerLoss,
	type RemovalRecord,
	readRemovals,
	recordRemovals,
	removalActor,
} from "../core/removal-log";
import { formatWarn } from "../core/style";
import { resolveComposeServiceNames } from "../planning";
import type { ServiceConfig } from "../types";
import { composeServicesOf } from "./stacks";

interface TeardownTarget {
	projectName: string;
	root: string;
	runtime: Pick<ContainerRuntimeAdapter, "name" | "list">;
}

interface LossTarget extends TeardownTarget {
	services: Readonly<Record<string, ServiceConfig>>;
	selectedServiceKeys: readonly string[];
}

/**
 * Why this run's containers are gone, or `undefined` while they are all
 * there (or the runtime cannot say).
 *
 * For failure paths only: it lists the runtime's containers, and a run that
 * is working has no reason to pay for that. `since` is when the run claimed
 * them, so a removal from before this run is not blamed for its failure.
 */
export function explainMissingContainers(
	target: LossTarget,
	since: number,
	deps: { now?: number; records?: () => RemovalRecord[] } = {},
): string | undefined {
	const selected = Object.fromEntries(
		target.selectedServiceKeys.flatMap((key) => {
			const service = target.services[key] as ServiceConfig | undefined;
			return service ? [[key, service]] : [];
		}),
	);
	const compose = composeServicesOf(selected);
	const expected = resolveComposeServiceNames(compose, Object.keys(compose));
	if (expected.length === 0) return undefined;

	let present: Set<string>;
	try {
		present = new Set(
			target.runtime
				.list()
				.filter((container) => container.project === target.projectName)
				.map((container) => container.service),
		);
	} catch {
		// A runtime that does not answer says nothing about what it holds.
		return undefined;
	}
	if (expected.every((name) => present.has(name))) return undefined;

	return explainContainerLoss({
		projectName: target.projectName,
		root: target.root,
		runtime: target.runtime.name,
		since,
		now: deps.now ?? Date.now(),
		records: (deps.records ?? readRemovals)(),
	});
}

/** Record an explicit teardown (`stop()`, `dev --down`, `ci`'s own). */
export function recordTeardown(
	target: TeardownTarget,
	input: { sessionId: string; runtimes: string[]; removeVolumes: boolean },
): Promise<void> {
	const at = new Date().toISOString();
	const by = removalActor();
	return recordRemovals(
		input.runtimes.map((runtime) => ({
			at,
			projectName: target.projectName,
			root: target.root,
			runtime,
			reason: input.removeVolumes ? "stopped, volumes included" : "stopped",
			owner: { sessionId: input.sessionId, pid: process.pid },
			by,
		})),
	);
}

/**
 * Run `work`, and when it fails while the containers it depends on are
 * gone, say who removed them before the error goes on.
 *
 * The error itself is usually a refused connection, which says nothing about
 * the cause. The explanation is printed rather than folded into the error, so
 * a caller that matches on the error sees the one it always did.
 */
export async function withLossNotice<T>(
	explain: () => string | undefined,
	work: () => Promise<T>,
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const loss = isAbort(error) ? undefined : explain();
		if (loss) console.warn(formatWarn(loss));
		throw error;
	}
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
