/**
 * The sweep: remove every container stack nobody owns any more.
 *
 * Containers carry their project and checkout as labels, and every run that
 * owns containers has an entry in `~/.buncargo/runs.json`. Comparing the two
 * answers "is anyone using this?" for the whole machine from one listing and
 * one file, which is what lets the watchdog be a single process rather than
 * one per project, and what lets `ls` and `doctor` clean up after a watchdog
 * that was killed.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import { getErrorMessage, typedSwitch } from "hanzio";
import {
	type CheckoutPresence,
	checkoutDeleted,
	checkoutPresence,
} from "../core/checkout-presence";
import { FileLockTimeoutError } from "../core/file-lock";
import { loadHostRoutes, withdrawHostRoutes } from "../core/hosts/registry";
import {
	dropDeletedOffsetClaims,
	markDeletedOffsetClaims,
	markOffsetClaimsReclaimed,
	type OffsetClaim,
	offsetClaimHoldsBlock,
	offsetClaimRoot,
	RECLAIM_MIN_IDLE_MS,
	readAllOffsetClaims,
	releaseSuffixedClaimsOf,
	retireOffsetClaimsIfUnchanged,
} from "../core/offset-claims";
import { execAsync } from "../core/process/exec";
import {
	type RemovalActor,
	type RemovalOwner,
	recordEvents,
	removalActor,
	removalOwner,
} from "../core/removal-log";
import {
	clearRunStacks,
	findCheckoutRuns,
	type HoldExpiry,
	holdExpiry,
	markOwnersLost,
	newestLifecycleFirst,
	ownerChange,
	type RunEntry,
	type RunStackEntry,
	readAllRuns,
	retireRuns,
	runLivenessAsync,
} from "../core/run-registry";
import { pruneDeletedCheckoutVolumes } from "../core/runtime-flags";
import { lookupOnPath } from "../core/tool-binary";
import {
	DELETED_CHECKOUT_SETTLE_MS,
	WATCHDOG_OWNER_DEAD_GRACE_MS,
} from "../core/watchdog-constants";
import type {
	BuncargoContainer,
	BuncargoVolume,
	ContainerRuntimeName,
} from "../types";
import { keepsUnownedStack, parseContainerState } from "./container-state";
import { buncargoContainersOn } from "./containers";
import {
	type ContainerGroup,
	groupBuncargoContainers,
	manualDownCommand,
} from "./inventory";
import { withProjectLifecycleLock } from "./project-lock";
import { claimedCheckouts } from "./prune";
import {
	containerRuntimeCandidates,
	getContainerRuntimeAdapter,
} from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";
import { decideVolume, type VolumeState } from "./volume-decision";

export interface SweepInput {
	/**
	 * This user's state names the stack: a run in `runs.json` or a port claim
	 * in `offsets.json` for its project and checkout. Nothing else is ours to
	 * remove (see {@link isKnownStack}).
	 */
	known: boolean;
	/**
	 * Whether the checkout the containers were started from is still there.
	 * Only `deleted` (confirmed missing) condemns a stack; `unknown`, a path
	 * this user cannot read, counts as there.
	 */
	checkout: CheckoutPresence;
	/**
	 * At least one container keeps the stack up ({@link keepsUnownedStack}):
	 * live, and not only restarting.
	 */
	anyRunning: boolean;
	/** The run that owns them, or null when nothing on disk claims them. */
	run: RunEntry | null;
	ownerAlive: boolean;
	now: number;
}

export type SweepVerdict =
	| { kind: "keep" }
	| { kind: "down"; reason: string }
	/** Not this user's to remove; reported and left alone. */
	| { kind: "foreign"; reason: string };

function seconds(ms: number): string {
	return `${Math.ceil(ms / 1000)}s`;
}

/**
 * Whether a stack should be removed. Pure, so the policy is tested without
 * containers or minutes of waiting.
 */
export function decideSweep(
	input: SweepInput,
	limits: { ownerDeadGraceMs: number } = {
		ownerDeadGraceMs: WATCHDOG_OWNER_DEAD_GRACE_MS,
	},
): SweepVerdict {
	const { known, checkout, anyRunning, run, ownerAlive, now } = input;
	if (!known) return { kind: "foreign", reason: foreignReason(input) };
	// A live owner keeps its stack whatever the checkout looks like: a run
	// between `start()` and `startServers()` is using these containers.
	if (ownerAlive) return { kind: "keep" };
	if (checkout === "deleted")
		return { kind: "down", reason: "checkout deleted" };
	if (!anyRunning) return { kind: "down", reason: "stopped with no owner" };
	// Running, unowned, and nothing on record: an old CLI or a hand-started
	// stack. Only the two rules above may touch it.
	if (!run) return { kind: "keep" };

	// A hold of the checkout keeps the stack however the run ended:
	// `--keep-containers`, a one-shot mode, or a script that brought a stack
	// up and exited, which to the sweep looks exactly like a crash. An owner
	// gone but not yet stamped lost was only just noticed.
	const expiry = holdExpiry(run, limits.ownerDeadGraceMs);
	if (!expiry) return { kind: "keep" };
	const endedFor = now - expiry.endedAt;
	if (endedFor < expiry.holdMs) return { kind: "keep" };
	return { kind: "down", reason: expiryReason(expiry, seconds(endedFor)) };
}

function expiryReason(expiry: HoldExpiry, endedFor: string): string {
	if (expiry.inherited) return `ended ${endedFor} ago, past the hold it reused`;
	return typedSwitch(expiry.ended, {
		released: () => `released ${endedFor} ago`,
		lost: () => `owner gone for ${endedFor}`,
	});
}

/** Why a stack nobody here knows is still worth a look. */
function foreignReason({
	checkout,
	anyRunning,
}: Pick<SweepInput, "checkout" | "anyRunning">): string {
	return typedSwitch(checkout, {
		unknown: () => "this user cannot read its checkout",
		deleted: () => "its checkout was deleted",
		present: () => (anyRunning ? "it is running" : "it is stopped"),
	});
}

/**
 * Whether this user's own state names a stack: a run in `runs.json` (any
 * session, live or not) or a port claim in `offsets.json` with its project
 * and checkout.
 *
 * Only such a stack may be removed. Several users can share one container
 * daemon, and a stack another user's buncargo started is listed here with
 * none of its runs: to this user it looks unowned, and its checkout,
 * under a home this user cannot read, looks deleted.
 */
export function isKnownStack(
	stack: { projectName: string; root: string },
	runs: readonly Pick<RunEntry, "projectName" | "root">[],
	claims: Record<string, OffsetClaim>,
): boolean {
	return (
		runs.some(
			(run) => run.projectName === stack.projectName && run.root === stack.root,
		) ||
		Object.entries(claims).some(
			([key, claim]) =>
				claim.projectName === stack.projectName &&
				offsetClaimRoot(key, claim) === stack.root,
		)
	);
}

/** A stack the sweep found and left alone because this user's state does not name it. */
export interface ForeignStack {
	projectName: string;
	root: string;
	runtime: ContainerRuntimeName;
	reason: string;
	/** What removes it by hand, if it really is orphaned. Keeps its volumes. */
	command: string;
}

function foreignStack(group: ContainerGroup, reason: string): ForeignStack {
	return {
		projectName: group.projectName,
		root: group.root,
		runtime: group.runtime,
		reason,
		command: manualDownCommand(group),
	};
}

export interface SweptStack {
	projectName: string;
	root: string;
	/** The container runtime, or the integration stack's name (`supabase`). */
	runtime: ContainerRuntimeName | string;
	reason: string;
	/** The run the removal was decided against, when one is on record. */
	owner?: RemovalOwner;
	/** Set when volumes were removed rather than containers. */
	volumes?: string[];
}

/** Record a removal in the result and in the removal log. */
type NoteSwept = (stack: SweptStack) => Promise<void>;

export interface SweepResult {
	swept: SweptStack[];
	failed: { projectName: string; root: string; error: string }[];
	/** Buncargo containers found before sweeping, on every runtime that answered. */
	containers: number;
	/** Runs still alive, so the watchdog knows whether it has anything to watch. */
	liveRuns: number;
	/** Runs whose integration stacks are still recorded, so still to be stopped. */
	pendingStacks: number;
	/** The runtimes whose listing succeeded; an empty list means none is up. */
	answered: ContainerRuntimeName[];
	/** Stacks still standing afterwards, so a caller need not list again. */
	remaining: ContainerGroup[];
	/**
	 * Stacks this user's state does not name, so not this sweep's to remove:
	 * another user's buncargo on a shared daemon, or state that was wiped.
	 * Also in `remaining`.
	 */
	foreign: ForeignStack[];
	/** The registry as the sweep read it, and which of its sessions are live. */
	runs: RunEntry[];
	liveSessions: ReadonlySet<string>;
}

export interface SweepOptions {
	/** The project the caller itself is running; never touched. */
	except?: { projectName: string; root: string };
	/** Defaults to every backend, unprobed: a failed listing is the probe. */
	runtimes?: ContainerRuntimeAdapter[];
	now?: number;
	/** Who is sweeping, for the removal log; defaults to this process's command. */
	actor?: RemovalActor;
}

/** The run that owns a stack: a live session if there is one, else the one that ended last. */
function runFor(
	group: Pick<RunEntry, "projectName" | "root">,
	runs: RunEntry[],
	alive: (run: RunEntry) => boolean,
): RunEntry | null {
	const candidates = runs
		.filter(
			(run) => run.projectName === group.projectName && run.root === group.root,
		)
		.sort(newestLifecycleFirst);
	// A live owner speaks for the stack even when a released entry is newer:
	// a second session in the same checkout keeps the containers alive.
	return candidates.find(alive) ?? candidates[0] ?? null;
}

/** The adapter to tear a group down with: the one that listed it, or the pinned binary. */
function adapterFor(
	group: ContainerGroup,
	runtimes: ContainerRuntimeAdapter[],
	run: RunEntry | null,
): ContainerRuntimeAdapter {
	const pinned = run?.services.find(
		(service) =>
			service.container?.runtime === group.runtime && service.container.binary,
	)?.container;
	if (pinned?.binary)
		return getContainerRuntimeAdapter(group.runtime, { binary: pinned.binary });
	return (
		runtimes.find((runtime) => runtime.name === group.runtime) ??
		getContainerRuntimeAdapter(group.runtime)
	);
}

/**
 * Tear down every unowned stack, then retire the entries left with nothing.
 *
 * Throws when the registry cannot be read. Nothing has been touched by then,
 * and guessing would be worse than stopping: with no registry every stack on
 * the machine looks unowned. The caller decides what a failed pass means —
 * the watchdog retries on its next tick.
 *
 * Each group is decided under its own project lock, so a run that is starting
 * holds the sweep off, and a lock that is busy simply means "someone is
 * working here": skip it this pass.
 */
export async function sweepOrphanedContainers(
	options: SweepOptions = {},
): Promise<SweepResult> {
	const runtimes = options.runtimes ?? containerRuntimeCandidates();
	const answered: ContainerRuntimeName[] = [];
	const containers: BuncargoContainer[] = [];
	for (const runtime of runtimes) {
		try {
			containers.push(...(await buncargoContainersOn(runtime)));
			answered.push(runtime.name);
		} catch {
			// Not up, or not installed: it has nothing for us this pass.
		}
	}

	const runs = await readAllRuns();
	const claims = readAllOffsetClaims();
	const alive = await runLivenessAsync(runs);
	const now = options.now ?? Date.now();
	const groups = groupBuncargoContainers(containers);
	const owners = new Map(
		groups.map((group) => [group, runFor(group, runs, alive)]),
	);
	const stackRuns = runs.filter((run) => (run.stacks?.length ?? 0) > 0);
	await stampLostOwners([...owners.values(), ...stackRuns], runs, alive, now);

	const result: SweepResult = {
		swept: [],
		failed: [],
		containers: containers.length,
		liveRuns: runs.filter(alive).length,
		pendingStacks: 0,
		answered,
		remaining: [],
		foreign: [],
		runs,
		liveSessions: new Set(runs.filter(alive).map((run) => run.sessionId)),
	};
	// Read on the first removal: naming the actor forks a `ps`, which a sweep
	// that removes nothing (most `ls`) has no reason to pay for.
	let actor = options.actor;
	const swept: NoteSwept = async (stack) => {
		result.swept.push(stack);
		actor ??= removalActor();
		const { volumes, ...removed } = stack;
		const at = new Date().toISOString();
		await recordEvents([
			volumes
				? { kind: "volumes", at, ...removed, volumes, by: actor }
				: { kind: "containers", at, ...removed, by: actor },
		]);
	};

	for (const group of groups) {
		const run = owners.get(group) ?? null;
		const excepted =
			options.except?.projectName === group.projectName &&
			options.except.root === group.root;
		const removed =
			!excepted &&
			(await sweepGroup(
				group,
				run,
				claims,
				alive,
				now,
				runtimes,
				result,
				swept,
			));
		if (!removed) result.remaining.push(group);
	}

	for (const run of stackRuns) {
		const excepted =
			options.except?.projectName === run.projectName &&
			options.except.root === run.root;
		if (!excepted)
			await sweepStacks(run, runs, alive, now, runtimes, result, swept);
	}
	result.pendingStacks = stackRuns.filter(
		(run) => (run.stacks?.length ?? 0) > 0,
	).length;

	try {
		await settleDeletedCheckouts({
			runtimes: runtimes.filter((runtime) => answered.includes(runtime.name)),
			runs,
			stacks: result.remaining,
			result,
			now,
			swept,
		});
	} catch (error) {
		// A busy claims file: the deleted checkouts are still there next pass.
		if (!(error instanceof FileLockTimeoutError)) throw error;
	}

	const finished = finishedRuns(runs, groups, answered, alive);
	try {
		await settleThrowawayClaims({
			runtimes: runtimes.filter((runtime) => answered.includes(runtime.name)),
			runs,
			finished,
			stacks: result.remaining,
			except: options.except,
			now,
		});
	} catch (error) {
		// A busy claims file: these are still abandoned next pass.
		if (!(error instanceof FileLockTimeoutError)) throw error;
	}

	try {
		await retireRuns(finished);
	} catch {
		// A busy registry: these are still finished next pass.
	}
	return result;
}

/**
 * Free the blocks of throwaway runs that left nothing
 * ({@link abandonedThrowawayClaims}), and retire the throwaway claims nothing
 * of whose project is left ({@link spentThrowawayClaims}). A throwaway run
 * claims under a new suffix every time (`ci-<id>`), so a claim kept for good
 * would fill `offsets.json`.
 */
async function settleThrowawayClaims(input: {
	runtimes: readonly ContainerRuntimeAdapter[];
	runs: readonly RunEntry[];
	finished: readonly RunEntry[];
	stacks: readonly Pick<ContainerGroup, "projectName" | "root">[];
	except?: { projectName: string; root: string };
	now: number;
}): Promise<void> {
	const { runtimes, now } = input;
	const claims = readAllOffsetClaims();
	await markOffsetClaimsReclaimed(
		abandonedThrowawayClaims({
			...input,
			claims,
			runtimeAnswered: runtimes.length > 0,
		}),
		new Date(now).toISOString(),
	);
	// Volumes are listed only when a claim could be retired, and only from
	// runtimes that answered: from one that is down, no volume means nothing.
	const spent = (volumeProjects: ReadonlySet<string>) =>
		spentThrowawayClaims({ ...input, claims, volumeProjects });
	if (runtimes.length === 0 || Object.keys(spent(new Set())).length === 0)
		return;
	let volumes: BuncargoVolume[];
	try {
		volumes = (
			await Promise.all(runtimes.map((runtime) => runtime.listVolumes()))
		).flat();
	} catch {
		// A runtime that cannot list its volumes may hold the project's.
		return;
	}
	await retireOffsetClaimsIfUnchanged(
		spent(new Set(volumes.flatMap((volume) => volume.project ?? []))),
	);
}

/**
 * The throwaway claims (a CI dev run's, a suffixed environment's) that still
 * hold a block their run left nothing behind on: no live run, no container
 * still listed, and every run of the environment on record retired by this
 * pass. A run killed before its teardown gave up the block would otherwise
 * keep it until the range filled: a CI runner's directory never goes, and an
 * app-only run has no stack whose removal releases it.
 *
 * A claim used after its run started is a new job's, which allocates before it
 * publishes its run. With no run on record nothing dates the claim, so one
 * used within {@link RECLAIM_MIN_IDLE_MS} is taken for such a job's, and stays,
 * as does every one while no runtime answers to say no container is left. A
 * deleted checkout's claim is the sweep's record of its volumes
 * ({@link settleDeletedCheckouts}).
 */
export function abandonedThrowawayClaims(input: {
	claims: Record<string, OffsetClaim>;
	runs: readonly RunEntry[];
	finished: readonly RunEntry[];
	stacks: readonly Pick<ContainerGroup, "projectName" | "root">[];
	except?: { projectName: string; root: string };
	runtimeAnswered: boolean;
	now: number;
}): Record<string, OffsetClaim> {
	const { runs, finished, stacks, except, now } = input;
	const abandoned = ([key, claim]: [string, OffsetClaim]) => {
		if (claim.throwaway !== true || !offsetClaimHoldsBlock(claim)) return false;
		const root = offsetClaimRoot(key, claim);
		const ofClaim = (stack: { projectName: string; root: string }) =>
			stack.projectName === claim.projectName && stack.root === root;
		if (
			(except && ofClaim(except)) ||
			stacks.some(ofClaim) ||
			checkoutDeleted(root)
		)
			return false;
		const envRuns = runs.filter(ofClaim).sort(newestLifecycleFirst);
		const lastUsed = claim.usedAt;
		const [newest] = envRuns;
		if (newest)
			return (
				envRuns.every((run) => finished.includes(run)) &&
				lastUsed <= newest.startedAt
			);
		const idleFor = now - Date.parse(lastUsed);
		return input.runtimeAnswered && idleFor >= RECLAIM_MIN_IDLE_MS;
	};
	return Object.fromEntries(Object.entries(input.claims).filter(abandoned));
}

/**
 * The throwaway claims of existing checkouts that gave up their block and
 * name a project nothing is left of: no container listed, no run on record
 * and no volume (`volumeProjects`). Until then the claim is the record that
 * those volumes are this checkout's, which the sweep needs once the checkout
 * is deleted ({@link settleDeletedCheckouts}).
 */
export function spentThrowawayClaims(input: {
	claims: Record<string, OffsetClaim>;
	runs: readonly Pick<RunEntry, "projectName" | "root">[];
	stacks: readonly Pick<ContainerGroup, "projectName" | "root">[];
	volumeProjects: ReadonlySet<string>;
	except?: { projectName: string; root: string };
}): Record<string, OffsetClaim> {
	const { runs, stacks, volumeProjects, except } = input;
	const spent = ([key, claim]: [string, OffsetClaim]) => {
		if (claim.throwaway !== true || offsetClaimHoldsBlock(claim)) return false;
		const root = offsetClaimRoot(key, claim);
		const ofClaim = (stack: { projectName: string; root: string }) =>
			stack.projectName === claim.projectName && stack.root === root;
		return (
			!(except && ofClaim(except)) &&
			!stacks.some(ofClaim) &&
			!runs.some(ofClaim) &&
			!volumeProjects.has(claim.projectName) &&
			!checkoutDeleted(root)
		);
	};
	return Object.fromEntries(Object.entries(input.claims).filter(spent));
}

/**
 * Run a run's recorded stack `down` commands in order, each once the one
 * before it has succeeded.
 *
 * From the checkout, or from home once the checkout is gone: a deleted
 * worktree's stack must still come down.
 */
export async function runStackDowns(
	run: Pick<RunEntry, "root" | "stacks">,
	onDown: (stack: RunStackEntry) => void | Promise<void> = () => {},
	runtimes: readonly ContainerRuntimeAdapter[] = [],
): Promise<void> {
	const cwd = existsSync(run.root) ? run.root : homedir();
	for (const stack of run.stacks ?? []) {
		const down = runnableDown(stack.down);
		if (down) await execAsync(down, cwd, {}, { timeoutMs: 120_000 });
		else await stopStackByLabel(stack, runtimes);
		await onDown(stack);
	}
}

/**
 * The recorded `down`, or the same command from `PATH` when its binary was
 * an absolute path that is gone: the CLI in a deleted checkout's
 * `node_modules`. Undefined when neither exists.
 */
function runnableDown(argv: readonly string[]): readonly string[] | undefined {
	const [bin, ...rest] = argv;
	if (bin === undefined || !isAbsolute(bin) || existsSync(bin)) return argv;
	const found = lookupOnPath(basename(bin));
	return found ? [found, ...rest] : undefined;
}

/**
 * Stop a stack whose CLI cannot run, by the Compose project label its
 * containers carry. Stopped, not removed, so volumes and data stay. On a
 * runtime that records Compose projects: the integration CLIs run their
 * stacks on Docker.
 */
async function stopStackByLabel(
	stack: RunStackEntry,
	runtimes: readonly ContainerRuntimeAdapter[],
): Promise<void> {
	const compose =
		runtimes.find((runtime) => runtime.capabilities.composeProjectResources) ??
		getContainerRuntimeAdapter("docker");
	if (!stack.composeProject)
		throw new Error(
			`${stack.name}'s stop command \`${stack.down[0]}\` is gone, and nothing records its containers' project`,
		);
	const ids = (await compose.listComposeProjectResources()).containers
		.filter(
			(container) =>
				container.project === stack.composeProject && container.running,
		)
		.map((container) => container.id);
	await compose.stop(ids);
}

/**
 * Withdraw a checkout's service routes, and the stopped run's own, once its
 * containers came down. Left registered, a later run that falls back to
 * `localhost:port` gets the named URLs from `getEnvVar` all the same. Not
 * while another run of the checkout is live: its routes are its own.
 *
 * Best effort: a routes file that cannot be read is reported by every path
 * that needs it, and a containers teardown must not fail on it.
 */
export async function withdrawStoppedRoutes(
	root: string,
	pid: number | undefined,
): Promise<void> {
	try {
		const routes = await loadHostRoutes();
		if (!routes.some((route) => route.root === root)) return;
		if ((await findCheckoutRuns(root)).live.length > 0) return;
		// No route records pid 0: with no owner, only the service routes go.
		await withdrawHostRoutes({ root, pid: pid ?? 0 });
	} catch {
		// The next teardown in this checkout tries again.
	}
}

/**
 * Decide one stack and tear it down if it is condemned. True when removed.
 *
 * A stack condemned from the pass's snapshot is decided again from a fresh
 * read, under its lock, before anything is removed. The snapshot predates the
 * lock, and a new run publishes its claim before it takes the lock to reuse
 * these containers — so without the recheck, a pass busy with other stacks
 * could tear down containers a run had claimed in the meantime.
 */
async function sweepGroup(
	group: ContainerGroup,
	run: RunEntry | null,
	claims: Record<string, OffsetClaim>,
	alive: (run: RunEntry) => boolean,
	now: number,
	runtimes: ContainerRuntimeAdapter[],
	result: SweepResult,
	swept: NoteSwept,
): Promise<boolean> {
	const decide = (
		owner: RunEntry | null,
		isAlive: (run: RunEntry) => boolean,
		claims: Record<string, OffsetClaim>,
	) =>
		decideSweep({
			// `runFor` finds an owner exactly when a run on record names the stack.
			known: owner !== null || isKnownStack(group, [], claims),
			checkout: checkoutPresence(group.root),
			anyRunning: group.containers.some((container) =>
				keepsUnownedStack(parseContainerState(container.state)),
			),
			run: owner,
			ownerAlive: owner !== null && isAlive(owner),
			now,
		});
	const verdict = decide(run, alive, claims);
	if (verdict.kind === "foreign") {
		result.foreign.push(foreignStack(group, verdict.reason));
		return false;
	}
	if (verdict.kind !== "down") return false;

	try {
		return await withProjectLifecycleLock(
			group.projectName,
			group.root,
			async () => {
				const fresh = await readAllRuns();
				const freshAlive = await runLivenessAsync(fresh);
				const owner = runFor(group, fresh, freshAlive);
				const freshClaims = readAllOffsetClaims();
				const verdict = decide(owner, freshAlive, freshClaims);
				if (verdict.kind !== "down") return false;
				await adapterFor(group, runtimes, run).down({
					root: group.root,
					projectName: group.projectName,
					verbose: false,
				});
				await swept({
					projectName: group.projectName,
					root: group.root,
					runtime: group.runtime,
					reason: verdict.reason,
					owner: removalOwner(owner),
				});
				await releaseSuffixedClaimsOf(group, freshClaims, owner, now);
				await withdrawStoppedRoutes(group.root, owner?.pid);
				return true;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		// A run is starting or stopping there; it will be decided next pass.
		if (!(error instanceof FileLockTimeoutError))
			result.failed.push({
				projectName: group.projectName,
				root: group.root,
				error: getErrorMessage(error),
			});
		return false;
	}
}

/**
 * Settle the port claims of deleted checkouts: drop each once nothing of its
 * project is left for `prune` to propose, and on the machine's opt-in
 * (`BUNCARGO_PRUNE_DELETED_CHECKOUTS=1`) remove the volumes {@link decideVolume}
 * proposes first.
 *
 * Works from the claims rather than from container stacks, because by the
 * time a worktree is deleted its containers are usually long gone. A
 * checkout's suffixed environments (E2E, `buncargo ci`) have claims of their
 * own, each naming its own project, and keep them after their run gave up its
 * block, so their volumes settle the same way.
 *
 * Without the opt-in a claim whose project still has volumes stays: it is the
 * only record that they were a deleted checkout's, and what lets `prune`
 * propose them.
 *
 * A claim is also what makes its checkout's stack this user's to remove
 * ({@link isKnownStack}), so it stays while `stacks` (what is still listed)
 * holds one of its project and checkout: a stack whose removal failed, or
 * whose lock was busy, would otherwise be left to nobody.
 *
 * Volumes the sweep removes need more proof than containers: the checkout
 * confirmed missing (not merely unreadable) on two passes at least
 * {@link DELETED_CHECKOUT_SETTLE_MS} apart, the first stamped on the claim. A
 * path that is briefly missing, an unmounted disk or a worktree being
 * recreated, must not cost a database.
 */
export async function settleDeletedCheckouts(input: {
	runtimes: ContainerRuntimeAdapter[];
	runs: RunEntry[];
	stacks: readonly Pick<ContainerGroup, "projectName" | "root">[];
	result: Pick<SweepResult, "failed">;
	now: number;
	swept: NoteSwept;
}) {
	const { runtimes, runs, stacks, result, now, swept } = input;
	// With no runtime answering, nothing says whether its stack or its
	// volumes are left.
	if (runtimes.length === 0) return;
	const claims = Object.entries(readAllOffsetClaims()).map(([key, claim]) => ({
		key,
		root: offsetClaimRoot(key, claim),
		claim,
	}));
	const deleted = claims.filter(
		({ root, claim }) =>
			checkoutDeleted(root) &&
			!stacks.some(
				(stack) =>
					stack.projectName === claim.projectName && stack.root === root,
			),
	);
	// A checkout that is back starts over: its next deletion is a first sighting.
	const back = claims.filter(
		({ root, claim }) =>
			claim.deletedSeenAt !== undefined && checkoutPresence(root) === "present",
	);
	if (deleted.length === 0 && back.length === 0) return;
	await markDeletedOffsetClaims({
		seen: deleted
			.filter(({ claim }) => claim.deletedSeenAt === undefined)
			.map(({ key }) => key),
		back: back.map(({ key }) => key),
		at: new Date(now).toISOString(),
	});
	if (deleted.length === 0) return;

	const containers: BuncargoContainer[] = [];
	const listings: {
		runtime: ContainerRuntimeAdapter;
		volumes: BuncargoVolume[];
	}[] = [];
	try {
		for (const runtime of runtimes) {
			containers.push(...(await buncargoContainersOn(runtime)));
			listings.push({ runtime, volumes: await runtime.listVolumes() });
		}
	} catch {
		// A runtime that cannot answer could hold the project's containers.
		return;
	}

	const prune = pruneDeletedCheckoutVolumes();
	const state: VolumeState = {
		containerProjects: new Set(
			containers.map((container) => container.project),
		),
		runs: runs.map((run) => ({
			projectName: run.projectName,
			root: run.root,
			deleted: checkoutDeleted(run.root),
		})),
		// Read again: the first sightings were stamped just now.
		checkouts: claimedCheckouts(readAllOffsetClaims()),
		...(prune
			? { deletedFor: { ms: DELETED_CHECKOUT_SETTLE_MS, now } }
			: undefined),
	};
	const settled: string[] = [];
	for (const {
		key,
		root,
		claim: { projectName },
	} of deleted) {
		const decided = listings.map(({ runtime, volumes }) => ({
			runtime,
			volumes: volumes
				.filter((volume) => volume.project === projectName)
				.map((volume) => ({
					name: volume.name,
					decision: decideVolume(volume, state),
				})),
		}));
		const all = decided.flatMap(({ volumes }) => volumes);
		// A container, a run or a recent deletion: a later pass decides.
		if (all.some(({ decision }) => !decision.propose && decision.wait))
			continue;
		if (!all.some(({ decision }) => decision.propose)) {
			settled.push(key);
			continue;
		}
		if (!prune) continue;

		let refusedAny = false;
		for (const { runtime, volumes } of decided) {
			const ours = volumes
				.filter(({ decision }) => decision.propose)
				.map(({ name }) => name);
			if (ours.length === 0) continue;

			const refused = await runtime.removeVolumes(ours);
			for (const { name, error } of refused) {
				refusedAny = true;
				result.failed.push({
					projectName,
					root,
					error: `volume ${name}: ${error}`,
				});
			}

			const removed = ours.filter(
				(name) => !refused.some((entry) => entry.name === name),
			);
			if (removed.length > 0)
				await swept({
					projectName,
					root,
					runtime: runtime.name,
					reason: `checkout deleted, removed volumes ${removed.join(", ")}`,
					volumes: removed,
				});
		}
		if (!refusedAny) settled.push(key);
	}
	await dropDeletedOffsetClaims(settled);
}

/**
 * Stop the integration stacks (the Supabase CLI's containers) a run recorded,
 * when the same policy would take its containers down.
 *
 * Those containers carry none of our labels, so no listing finds them: the
 * recorded `down` command is the only handle, and it is safe to run on a stack
 * that is already gone. So the stack counts as running, and only the hold, the
 * crash grace and a deleted checkout decide. Any live session in the checkout
 * shares the stack (it runs under the project's name) and keeps it.
 */
async function sweepStacks(
	run: RunEntry,
	runs: RunEntry[],
	alive: (run: RunEntry) => boolean,
	now: number,
	runtimes: ContainerRuntimeAdapter[],
	result: SweepResult,
	swept: NoteSwept,
): Promise<void> {
	// The newest entry speaks for the checkout, as it does for containers.
	const decide = (runs: RunEntry[], isAlive: (run: RunEntry) => boolean) => {
		const owner = runFor(run, runs, isAlive);
		return {
			owner,
			verdict: decideSweep({
				// Recorded by a run of this user's: known by definition.
				known: true,
				checkout: checkoutPresence(run.root),
				anyRunning: true,
				run: owner,
				ownerAlive: owner !== null && isAlive(owner),
				now,
			}),
		};
	};
	if (decide(runs, alive).verdict.kind !== "down") return;

	try {
		await withProjectLifecycleLock(
			run.projectName,
			run.root,
			async () => {
				const fresh = await readAllRuns();
				const freshAlive = await runLivenessAsync(fresh);
				const { owner, verdict } = decide(fresh, freshAlive);
				const stacked = fresh.find(
					(entry) => entry.sessionId === run.sessionId,
				);
				if (verdict.kind !== "down" || !stacked?.stacks?.length) return;
				await runStackDowns(
					stacked,
					(stack) =>
						swept({
							projectName: run.projectName,
							root: run.root,
							runtime: stack.name,
							reason: verdict.reason,
							owner: removalOwner(owner),
						}),
					runtimes,
				);
				await clearRunStacks([stacked]);
				await withdrawStoppedRoutes(run.root, owner?.pid);
				// Retirable this pass, like an entry whose containers are gone.
				run.stacks = undefined;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError))
			result.failed.push({
				projectName: run.projectName,
				root: run.root,
				error: getErrorMessage(error),
			});
	}
}

/**
 * Stamp the moment a stack's owner was first found gone.
 *
 * Written into the registry so the next pass counts from the same moment, and
 * onto the in-memory entry so this pass decides with it. A write that fails
 * leaves the entry unstamped, which reads as "only just noticed": the stack
 * waits a pass longer rather than coming down early.
 */
async function stampLostOwners(
	owners: readonly (RunEntry | null)[],
	runs: readonly RunEntry[],
	alive: (run: RunEntry) => boolean,
	now: number,
): Promise<void> {
	const lost = [...new Set(owners)].filter(
		(run): run is RunEntry =>
			run !== null && ownerChange(run, alive(run)) === "lost",
	);
	// Found gone once, running now: that reading was wrong.
	const back = runs.filter((run) => ownerChange(run, alive(run)) === "back");
	await markOwnersLost({ lost, back, at: new Date(now).toISOString() }).catch(
		() => {},
	);
}

/**
 * Entries whose containers are gone, as read: {@link retireRuns} drops
 * each only while it is still that entry.
 *
 * Only when the runtime that holds them answered: from a daemon that is down,
 * an empty listing means "cannot tell", and retiring on that would throw away
 * the only record of a stack that is still there. A checkout that no longer
 * exists is the one case that needs no listing to be sure.
 */
function finishedRuns(
	runs: RunEntry[],
	groups: ContainerGroup[],
	answered: ContainerRuntimeName[],
	alive: (run: RunEntry) => boolean,
): RunEntry[] {
	const stillHasContainers = (run: RunEntry) =>
		groups.some(
			(group) =>
				group.projectName === run.projectName && group.root === run.root,
		);
	const runtimeAnswered = (run: RunEntry) => {
		const recorded = run.services.flatMap((service) =>
			service.container ? [service.container.runtime] : [],
		);
		return recorded.length > 0
			? recorded.every((name) => answered.includes(name))
			: answered.length > 0;
	};
	return runs.filter(
		(run) =>
			!alive(run) &&
			!stillHasContainers(run) &&
			// Its stacks are only recorded here; retiring would orphan them.
			(run.stacks?.length ?? 0) === 0 &&
			(runtimeAnswered(run) || checkoutDeleted(run.root)),
	);
}
