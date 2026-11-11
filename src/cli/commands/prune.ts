import {
	availableContainerRuntimes,
	type ContainerRuntimeAdapter,
	claimedCheckouts,
	containerRuntimeForEnv,
	formatSpan,
	isRuntimeUp,
	listBuncargoContainers,
	type ProjectPrunePlan,
	type ProjectPruneStack,
	planProjectPrune,
	planVolumePrune,
	sweepOrphanedContainers,
	type VolumeReport,
	withProjectLifecycleLock,
} from "../../container-runtime";
import { FileLockTimeoutError } from "../../core/file-lock";
import { listGitCheckouts } from "../../core/git-checkouts";
import {
	type OffsetClaim,
	readAllOffsetClaims,
} from "../../core/offset-claims";
import { askConfirm, isInteractive } from "../../core/prompt";
import { StateFileUnreadableError } from "../../core/registry-file";
import { readAllRuns, readLiveRuns } from "../../core/run-registry";
import { describeSwept } from "../../core/watchdog-loop";
import { loadDevEnv } from "../../loader";
import { defineCommand } from "../command-spec";
import * as log from "../log";

/** `7d`, `12h`, `30m` in milliseconds, or undefined when it is none of them. */
export function parseAge(value: string): number | undefined {
	const match = /^(\d+)(m|h|d)$/.exec(value.trim());
	if (!match) return undefined;
	const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
		match[2] as "m" | "h" | "d"
	];
	const ms = Number(match[1]) * unit;
	return ms > 0 ? ms : undefined;
}

interface PruneRequest {
	dryRun: boolean;
	yes: boolean;
	/** `--older-than` in milliseconds. */
	olderThanMs?: number;
}

export const pruneCommand = defineCommand({
	spec: {
		name: "prune",
		summary: "Remove volumes whose project is gone (destroys their data)",
		flags: {
			"dry-run": {
				kind: "boolean",
				description: "List what would be removed and stop",
			},
			yes: {
				kind: "boolean",
				description: "Skip the confirmation (for scripts)",
			},
			"older-than": {
				kind: "string",
				value: "<age>",
				description:
					"Only volumes of checkouts deleted at least this long ago, e.g. 7d, 12h, 30m",
				validate: (value: string) =>
					parseAge(value) === undefined
						? `--older-than expects an age such as 7d, 12h or 30m, got "${value}".`
						: undefined,
			},
			project: {
				kind: "boolean",
				description:
					"Only this project's leftovers: every checkout's ci stack and every stack of a deleted worktree (containers, volumes, networks)",
			},
		},
		notes: [
			{
				command: "",
				description:
					"Removes the volumes of checkouts whose directory was deleted, when no container, run or other checkout uses their project. Destroys their data.",
			},
		],
		examples: [
			{
				command: "bunx buncargo prune --dry-run",
				description: "List reclaimable volumes without touching them",
			},
			{
				command: "bunx buncargo prune",
				description: "Review the list, then confirm removal",
			},
			{
				command: "bunx buncargo prune --older-than=7d --dry-run",
				description: "Only checkouts deleted a week ago or longer",
			},
			{
				command: "bunx buncargo prune --project --dry-run",
				description:
					"List this project's leftover ci and deleted-worktree stacks",
			},
		],
	},
	exits: {
		0: "removed, listed (--dry-run), declined, or nothing to remove",
		1: "a removal failed, offsets.json is unreadable, or bad arguments",
	},
	run: ({ values }) => {
		const olderThan = values["older-than"];
		const parsed: PruneRequest = {
			dryRun: values["dry-run"],
			yes: values.yes,
			olderThanMs: olderThan === undefined ? undefined : parseAge(olderThan),
		};
		if (!values.project) return prune(parsed);
		if (parsed.olderThanMs !== undefined) {
			log.error(
				"--older-than applies to deleted checkouts' volumes, not to --project.",
			);
			return 1;
		}
		return pruneProject(parsed);
	},
});

/**
 * `buncargo prune`: reclaim the volumes of checkouts that were deleted.
 *
 * The sweep removes containers automatically because recreating one is free.
 * A volume is the database, so it is only ever removed from here, after the
 * person has seen the list. `--dry-run` shows it and stops; `--yes` is for a
 * script that has already decided.
 */
async function prune(parsed: PruneRequest): Promise<number> {
	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.info("No container runtime is running. Nothing to prune.");
		return 0;
	}

	// Unreadable claims would read as no checkout naming any volume.
	if (!readClaims()) return 1;

	// Sweeping first is what makes the volume answer meaningful: a project
	// whose containers are removed here stops counting as in use, and its
	// entry is retired in the same pass.
	const swept = await sweepOrphanedContainers({ runtimes });
	const deletedFor =
		parsed.olderThanMs === undefined
			? undefined
			: { ms: parsed.olderThanMs, now: Date.now() };
	for (const stack of swept.swept) log.info(describeSwept(stack));

	const inventory = async (): Promise<VolumeReport[] | undefined> => {
		const volumes = (
			await Promise.all(runtimes.map((runtime) => runtime.listVolumes()))
		).flat();
		const claims = readClaims();
		if (!claims) return undefined;
		return planVolumePrune({
			volumes,
			containers: await listBuncargoContainers(runtimes),
			runs: await readAllRuns(),
			checkouts: claimedCheckouts(claims),
			deletedFor,
		});
	};
	const reports = await inventory();
	if (!reports) return 1;

	reportUnattributed(reports);

	const proposed = reports.filter(
		(report) => report.verdict.kind === "orphaned",
	);
	if (proposed.length === 0) {
		log.info("No volumes to reclaim.");
		if (deletedFor)
			log.hint(
				`Only checkouts deleted at least ${formatSpan(deletedFor.ms)} ago count; without --older-than every deleted checkout does.`,
			);
		log.hint(
			"Only a deleted checkout's volumes are proposed here. A project's ci and deleted-worktree stacks: `buncargo prune --project --dry-run` in one of its checkouts.",
		);
		return 0;
	}

	log.line();
	log.info(
		`${proposed.length} volume${proposed.length === 1 ? "" : "s"} of deleted checkouts, with no containers and no run:`,
	);
	for (const { volume, verdict } of proposed)
		log.line(`  ${volume.name}  (${volume.project}: ${verdict.reason})`);
	log.line();
	log.warn("Removing these destroys their data, databases included.");

	if (parsed.dryRun) {
		log.hint("Run without --dry-run to remove them.");
		return 0;
	}

	if (!parsed.yes) {
		const accepted =
			isInteractive() &&
			(await askConfirm([
				`  Remove ${proposed.length} volume${proposed.length === 1 ? "" : "s"}? This cannot be undone.`,
				"",
				"  y to remove  ·  Enter to keep them",
			]));
		if (!accepted) {
			log.info("Kept. Nothing was removed.");
			return 0;
		}
	}

	let removed = 0;
	for (const project of new Set(proposed.map(({ volume }) => volume.project)))
		removed += await removeProjectVolumes(
			runtimes,
			proposed.filter(({ volume }) => volume.project === project),
			inventory,
		);
	log.done(`Removed ${removed} volume${removed === 1 ? "" : "s"}`);
	return 0;
}

/** Every port claim, or undefined (said) when `offsets.json` cannot be read. */
function readClaims(): Record<string, OffsetClaim> | undefined {
	try {
		return readAllOffsetClaims({ strict: true });
	} catch (error) {
		if (!(error instanceof StateFileUnreadableError)) throw error;
		log.error(`${error.message}. Nothing was removed.`);
		return undefined;
	}
}

/**
 * One project's listed volumes, under the lifecycle lock of the deleted
 * checkout they were proposed for, and decided again from fresh inventories:
 * since the listing, a checkout may have claimed the project, a run may have
 * started, the directory may be back. Only what was listed is removed.
 */
async function removeProjectVolumes(
	runtimes: readonly ContainerRuntimeAdapter[],
	listed: readonly VolumeReport[],
	inventory: () => Promise<VolumeReport[] | undefined>,
): Promise<number> {
	const [first] = listed;
	if (!first || first.verdict.kind !== "orphaned") return 0;
	const project = first.volume.project ?? "";
	try {
		return await withProjectLifecycleLock(
			project,
			first.verdict.root,
			async () => {
				const fresh = await inventory();
				if (!fresh) return 0;
				let removed = 0;
				for (const runtime of runtimes) {
					const names = listed
						.filter(({ volume }) => volume.runtime === runtime.name)
						.flatMap(({ volume }) => {
							const now = fresh.find(
								(report) =>
									report.volume.name === volume.name &&
									report.volume.runtime === volume.runtime,
							);
							if (now?.verdict.kind === "orphaned") return [volume.name];
							if (now) log.info(`Kept ${volume.name}: ${now.verdict.reason}.`);
							return [];
						});
					if (names.length === 0) continue;
					const failures = await runtime.removeVolumes(names);
					removed += names.length - failures.length;
					for (const failure of failures)
						log.warn(`Could not remove ${failure.name}: ${failure.error}`);
				}
				return removed;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError)) throw error;
		log.info(`Kept ${project}'s volumes: a run is starting or stopping it.`);
		return 0;
	}
}

/**
 * Volumes the runtime will not attribute to a project.
 *
 * Apple records no Compose project, and its `<project>-<volume>` names cannot
 * be split back apart, so these are named and left alone rather than guessed
 * at. Removing the wrong one here is somebody's database.
 */
function reportUnattributed(reports: readonly VolumeReport[]): void {
	const unattributed = reports.filter(
		(report) => report.verdict.kind === "unattributed",
	);
	if (unattributed.length === 0) return;
	// Counted, not listed: naming them invites removing one, and the whole
	// point is that we cannot say whose they are.
	log.info(
		`${unattributed.length} volume${unattributed.length === 1 ? "" : "s"} could not be traced to a project and ${unattributed.length === 1 ? "was" : "were"} left alone.`,
	);
}

/**
 * `buncargo prune --project`: this project's leftover stacks only.
 *
 * No sweep first, unlike the machine-wide prune: that would reach other
 * projects' stacks. Every inventory (Git, the runtime, the run registry) must
 * answer, or nothing is removed: an empty answer makes everything disposable.
 */
async function pruneProject(parsed: {
	dryRun: boolean;
	yes: boolean;
}): Promise<number> {
	const env = await loadDevEnv({ readOnly: true });
	const runtime = containerRuntimeForEnv(env);
	if (!runtime.capabilities.composeProjectResources) {
		log.error(
			`prune --project needs Docker. ${runtime.displayName} records no Compose project on its volumes, so none can be traced to a checkout.`,
		);
		return 1;
	}
	if (!isRuntimeUp(runtime)) {
		log.info(`${runtime.displayName} is not running. Nothing to prune.`);
		return 0;
	}

	// Every inventory must answer, or this throws before anything is removed.
	const inventory = async () => {
		const checkouts = listGitCheckouts(env.root);
		return {
			checkouts,
			plan: planProjectPrune({
				projectPrefix: env.projectPrefix,
				worktreeIsolation: env.worktreeIsolation,
				checkouts,
				resources: await runtime.listComposeProjectResources(),
				liveProjects: new Set(
					(await readLiveRuns()).map((run) => run.projectName),
				),
			}),
		};
	};
	const { checkouts, plan } = await inventory();

	for (const stack of plan.kept)
		log.info(`Kept ${stack.projectName}: ${stack.reason}.`);
	if (plan.remove.length === 0) {
		log.info(
			`Nothing to reclaim across ${checkouts.length} checkout${checkouts.length === 1 ? "" : "s"}. Every existing checkout's dev stack is kept.`,
		);
		return 0;
	}

	log.line();
	log.info(
		`${plan.remove.length} stack${plan.remove.length === 1 ? "" : "s"} of this project's ci runs and deleted worktrees:`,
	);
	for (const stack of plan.remove) {
		const parts = [
			count(stack.containers.length, "stopped container"),
			count(stack.volumes.length, "volume"),
			count(stack.networks.length, "network"),
		].filter(Boolean);
		log.line(`  ${stack.projectName}  (${parts.join(", ")})`);
		for (const volume of stack.volumes) log.line(`    volume  ${volume}`);
	}
	log.line();
	log.warn("Removing these destroys their data, databases included.");

	if (parsed.dryRun) {
		log.hint("Run without --dry-run to remove them.");
		return 0;
	}
	if (!parsed.yes) {
		const accepted =
			isInteractive() &&
			(await askConfirm([
				`  Remove ${plan.remove.length} stack${plan.remove.length === 1 ? "" : "s"}? This cannot be undone.`,
				"",
				"  y to remove  ·  Enter to keep them",
			]));
		if (!accepted) {
			log.info("Kept. Nothing was removed.");
			return 0;
		}
	}

	let removed = 0;
	for (const stack of plan.remove) {
		if (await removeStack(runtime, stack, inventory)) removed++;
	}
	log.done(
		`Removed ${removed} of ${plan.remove.length} stack${plan.remove.length === 1 ? "" : "s"}`,
	);
	return 0;
}

function count(n: number, noun: string): string {
	return n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One stack, under its lifecycle lock and decided again from fresh
 * inventories, like the sweep: since the listing, a run may have claimed it,
 * a deleted worktree may be back, a container may have started. Only what
 * was listed is removed. Containers first, without force, and a refused one
 * keeps the rest of the stack: its volume may be in use.
 */
async function removeStack(
	runtime: ContainerRuntimeAdapter,
	listed: ProjectPruneStack,
	inventory: () => Promise<{ plan: ProjectPrunePlan }>,
): Promise<boolean> {
	const remove = runtime.removeComposeProjectResource.bind(runtime);
	try {
		return await withProjectLifecycleLock(
			listed.projectName,
			listed.root,
			async () => {
				const { plan } = await inventory();
				const stack = plan.remove.find(
					(fresh) => fresh.projectName === listed.projectName,
				);
				if (!stack) {
					const reason =
						plan.kept.find((kept) => kept.projectName === listed.projectName)
							?.reason ?? "it is no longer a leftover";
					log.info(`Kept ${listed.projectName}: ${reason}.`);
					return false;
				}
				for (const [kind, names] of [
					["container", stack.containers],
					["volume", stack.volumes],
					["network", stack.networks],
				] as const) {
					const confirmed = new Set(listed[`${kind}s`]);
					for (const name of names.filter((name) => confirmed.has(name))) {
						const error = await remove(kind, name);
						if (error === undefined) continue;
						log.warn(
							`Kept the rest of ${stack.projectName}: ${kind} ${name}: ${error}`,
						);
						return false;
					}
				}
				return true;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError)) throw error;
		log.info(`Kept ${listed.projectName}: a run is starting or stopping it.`);
		return false;
	}
}
