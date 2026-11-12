import {
	type CheckoutStacks,
	type PortContainerOwner,
	staleStackProject,
} from "../core/process";
import { recordEvents, removalActor } from "../core/removal-log";
import { readLiveRuns } from "../core/run-registry";
import { formatStep, formatWarn } from "../core/style";
import type { BuncargoContainer, ContainerRuntimeName } from "../types";
import {
	buncargoContainersOn,
	containerPortOwners,
	isRuntimeUp,
} from "./containers";
import { withProjectLifecycleLock } from "./project-lock";
import { containerRuntimeCandidates } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/** A stack this checkout left under a project name it no longer runs under. */
export interface StaleStack {
	projectName: string;
	runtime: ContainerRuntimeName;
	/** The ports this run wants that it publishes. */
	ports: number[];
}

/**
 * The stale stacks of `checkout` that hold a port this run wants.
 *
 * A stale stack that holds none is left for the sweep or `prune`: nothing
 * about this start needs it gone.
 */
export function findStaleStacks(
	owners: ReadonlyMap<number, PortContainerOwner>,
	checkout: CheckoutStacks,
	runtime: ContainerRuntimeName,
	wantedPorts: ReadonlySet<number>,
): StaleStack[] {
	const stacks = new Map<string, StaleStack>();
	for (const [port, owner] of owners) {
		if (!wantedPorts.has(port)) continue;
		const projectName = staleStackProject(owner, checkout);
		if (!projectName) continue;
		const stack = stacks.get(projectName) ?? {
			projectName,
			runtime,
			ports: [],
		};
		stack.ports.push(port);
		stacks.set(projectName, stack);
	}
	return [...stacks.values()];
}

type StaleStackDecision = { remove: true } | { remove: false; reason: string };

/**
 * Whether a stale stack may be removed, decided under its lifecycle lock.
 *
 * `down` acts on the project name alone, so the whole project must be this
 * checkout's: a name two checkouts share (`worktreeIsolation: false`) can
 * carry this root on the container that holds the port and another root on
 * the rest. And a live run under that name, from any checkout, is somebody's
 * run rather than a leftover.
 */
export function decideStaleStack(input: {
	projectName: string;
	root: string;
	/** Every container of the project the runtime lists. */
	containers: readonly Pick<BuncargoContainer, "root">[];
	liveRuns: readonly { projectName: string; root: string; pid: number }[];
}): StaleStackDecision {
	const live = input.liveRuns.find(
		(run) => run.projectName === input.projectName,
	);
	if (live)
		return {
			remove: false,
			reason: `a live run (pid ${live.pid}, ${live.root}) still uses it. Stop that run (\`buncargo stop --all --root ${live.root}\`), then start again`,
		};

	const elsewhere = input.containers.find(
		(container) => container.root !== input.root,
	);
	if (elsewhere) {
		const where = elsewhere.root || "an unrecorded checkout";
		return {
			remove: false,
			reason: `it also has containers of ${where}, so it is not this checkout's alone`,
		};
	}
	return { remove: true };
}

export interface ReplaceStaleStacksResult {
	replaced: StaleStack[];
	kept: { stack: StaleStack; reason: string }[];
}

/**
 * `dev --replace-stale` and `start({ replaceStaleStacks: true })`: remove the
 * stacks this checkout left under an old project name that hold the ports
 * this run wants, before those ports are allocated, so the run keeps its
 * block instead of moving off it.
 *
 * Containers and networks only, through the runtime's own `down`: the old
 * stack's volumes stay, as every teardown but `--reset` and `prune` leaves
 * them.
 *
 * @param wantedPorts The block this run would take: the lockfile's, or the
 * unprobed preview's when there is none.
 * @param runtimes The selected runtime first, then any other: a stack the
 * checkout left on the other backend still holds its ports.
 */
export async function replaceStaleStacks(
	checkout: CheckoutStacks,
	wantedPorts: readonly number[],
	runtimes: readonly ContainerRuntimeAdapter[],
	options: { signal?: AbortSignal; verbose?: boolean } = {},
): Promise<ReplaceStaleStacksResult> {
	const { signal, verbose = true } = options;
	const result: ReplaceStaleStacksResult = { replaced: [], kept: [] };
	const wanted = new Set(wantedPorts);

	const found = await Promise.all(
		runtimes.map(async (runtime) => {
			const owners = await containerPortOwners(runtime, signal);
			const stacks = findStaleStacks(owners, checkout, runtime.name, wanted);
			return { runtime, stacks };
		}),
	);
	signal?.throwIfAborted();

	for (const { runtime, stacks } of found) {
		for (const stack of stacks) {
			const removeUnderLock = async (): Promise<StaleStackDecision> => {
				const decision = decideStaleStack({
					projectName: stack.projectName,
					root: checkout.root,
					containers: (await buncargoContainersOn(runtime, signal)).filter(
						(container) => container.project === stack.projectName,
					),
					liveRuns: await readLiveRuns(),
				});
				if (!decision.remove) return decision;

				if (verbose)
					console.log(
						formatStep(
							`♻️  Removing stale stack ${stack.projectName} of this checkout (holding ${stack.ports.join(", ")}); its volumes are kept`,
						),
					);
				await runtime.down({
					root: checkout.root,
					projectName: stack.projectName,
					removeVolumes: false,
					verbose,
					signal,
				});
				return decision;
			};
			const decision = await withProjectLifecycleLock(
				stack.projectName,
				checkout.root,
				removeUnderLock,
				{ signal },
			).catch((error: unknown): StaleStackDecision => {
				const message = error instanceof Error ? error.message : String(error);
				return {
					remove: false,
					reason: `it could not be checked or removed: ${message}`,
				};
			});

			if (!decision.remove) {
				result.kept.push({ stack, reason: decision.reason });
				if (verbose)
					console.warn(
						formatWarn(
							`Stale stack ${stack.projectName} (holding ${stack.ports.join(", ")}) left alone: ${decision.reason}.`,
						),
					);
				continue;
			}

			result.replaced.push(stack);
			await recordEvents([
				{
					kind: "containers",
					at: new Date().toISOString(),
					projectName: stack.projectName,
					root: checkout.root,
					runtime: runtime.name,
					reason: "replaced as a stale stack of this checkout",
					by: removalActor(),
				},
			]);
		}
	}
	return result;
}

/**
 * {@link replaceStaleStacks} on the selected runtime, then every other one
 * this machine could have. The others are not probed: one that is not there
 * fails its listing, which reads as "no stale stack". The selected one is, so
 * a flag that could not look says so instead of doing nothing in silence.
 */
export async function replaceStaleStacksOn(
	selected: ContainerRuntimeAdapter,
	checkout: CheckoutStacks,
	wantedPorts: readonly number[],
	options: { signal?: AbortSignal; verbose?: boolean } = {},
): Promise<ReplaceStaleStacksResult> {
	if (!isRuntimeUp(selected))
		console.warn(
			formatWarn(
				`--replace-stale: ${selected.displayName} is not running, so no stale stack was looked for on it. If a port conflict names one once it is up, run again.`,
			),
		);
	const others = containerRuntimeCandidates().filter(
		(candidate) => candidate.name !== selected.name,
	);
	return replaceStaleStacks(
		checkout,
		wantedPorts,
		[selected, ...others],
		options,
	);
}
