import {
	availableContainerRuntimes,
	type ContainerRuntimeAdapter,
	containerRuntimeForEnv,
	listBuncargoContainers,
	orphanedVolumes,
	type ProjectPruneStack,
	planProjectPrune,
	planVolumePrune,
	sweepOrphanedContainers,
	type VolumeReport,
	withProjectLifecycleLock,
} from "../../container-runtime";
import { FileLockTimeoutError } from "../../core/file-lock";
import { listGitCheckouts } from "../../core/git-checkouts";
import { askConfirm, isInteractive } from "../../core/prompt";
import { readAllRuns, readLiveRuns } from "../../core/run-registry";
import { loadDevEnv } from "../../loader";
import * as log from "../log";
import { parsePruneArgs, printPruneHelp } from "../prune-flags";

/**
 * `buncargo prune` — reclaim the volumes of projects that are gone.
 *
 * The sweep removes containers automatically because recreating one is free.
 * A volume is the database, so it is only ever removed from here, after the
 * person has seen the list. `--dry-run` shows it and stops; `--yes` is for a
 * script that has already decided.
 */
export async function handlePrune(args: string[] = []): Promise<number> {
	const parsed = parsePruneArgs(args);
	if (parsed.help) {
		printPruneHelp();
		return 0;
	}
	if (parsed.unknownFlags.length > 0) {
		log.error(`Unknown flag(s): ${parsed.unknownFlags.join(", ")}`);
		printPruneHelp();
		return 1;
	}
	if (parsed.project) return pruneProject(parsed);

	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.info("No container runtime is running. Nothing to prune.");
		return 0;
	}

	// Sweeping first is what makes the volume answer meaningful: a project
	// whose containers are removed here stops counting as in use, and its
	// entry is retired in the same pass.
	const swept = await sweepOrphanedContainers({ runtimes });
	for (const stack of swept.swept)
		log.info(`Removed ${stack.projectName} (${stack.root}): ${stack.reason}`);

	const volumes = (
		await Promise.all(runtimes.map((runtime) => runtime.listVolumes()))
	).flat();
	const reports = planVolumePrune({
		volumes,
		containers: listBuncargoContainers(runtimes),
		runs: await readAllRuns(),
	});

	reportUnattributed(reports);

	const names = orphanedVolumes(reports);
	if (names.length === 0) {
		log.info("No volumes to reclaim.");
		return 0;
	}

	log.line();
	log.info(
		`${names.length} volume${names.length === 1 ? "" : "s"} belong to projects with no containers and no run:`,
	);
	for (const report of reports) {
		if (report.verdict.kind !== "orphaned") continue;
		log.line(`  ${report.volume.name}  (${report.volume.project})`);
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
				`  Remove ${names.length} volume${names.length === 1 ? "" : "s"}? This cannot be undone.`,
				"",
				"  y to remove  ·  Enter to keep them",
			]));
		if (!accepted) {
			log.info("Kept. Nothing was removed.");
			return 0;
		}
	}

	let removed = 0;
	for (const runtime of runtimes) {
		const mine = reports
			.filter(
				(report) =>
					report.verdict.kind === "orphaned" &&
					report.volume.runtime === runtime.name,
			)
			.map((report) => report.volume.name);
		if (mine.length === 0) continue;
		const failures = await runtime.removeVolumes(mine);
		removed += mine.length - failures.length;
		for (const failure of failures)
			log.warn(`Could not remove ${failure.name}: ${failure.error}`);
	}
	log.done(`Removed ${removed} volume${removed === 1 ? "" : "s"}`);
	return 0;
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
	const list = runtime.listComposeProjectResources;
	if (!list || !runtime.removeComposeProjectResource) {
		log.error(
			`prune --project needs Docker. ${runtime.displayName} records no Compose project on its volumes, so none can be traced to a checkout.`,
		);
		return 1;
	}
	if (!runtime.isAvailable()) {
		log.info(`${runtime.displayName} is not running. Nothing to prune.`);
		return 0;
	}

	const checkouts = listGitCheckouts(env.root);
	const plan = planProjectPrune({
		projectPrefix: env.projectPrefix,
		worktreeIsolation: env.worktreeIsolation,
		checkouts,
		resources: list.call(runtime),
		liveProjects: await liveProjects(),
	});

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
		if (await removeStack(runtime, stack)) removed++;
	}
	log.done(
		`Removed ${removed} of ${plan.remove.length} stack${plan.remove.length === 1 ? "" : "s"}`,
	);
	return 0;
}

async function liveProjects(): Promise<Set<string>> {
	return new Set((await readLiveRuns()).map((run) => run.projectName));
}

function count(n: number, noun: string): string {
	return n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One stack, under its lifecycle lock and decided again from a fresh registry
 * read, like the sweep: a run that started since the listing claims before it
 * takes the lock. Containers first, without force, so a running one is
 * refused and its volume stays in use.
 */
async function removeStack(
	runtime: ContainerRuntimeAdapter,
	stack: ProjectPruneStack,
): Promise<boolean> {
	const remove = runtime.removeComposeProjectResource?.bind(runtime);
	if (!remove) return false;
	try {
		return await withProjectLifecycleLock(
			stack.projectName,
			stack.root,
			async () => {
				if ((await liveProjects()).has(stack.projectName)) {
					log.info(`Kept ${stack.projectName}: a run started using it.`);
					return false;
				}
				let complete = true;
				for (const [kind, names] of [
					["container", stack.containers],
					["volume", stack.volumes],
					["network", stack.networks],
				] as const) {
					for (const name of names) {
						const error = await remove(kind, name);
						if (error === undefined) continue;
						complete = false;
						log.warn(`Kept ${kind} ${name}: ${error}`);
					}
				}
				return complete;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError)) throw error;
		log.info(`Kept ${stack.projectName}: a run is starting or stopping it.`);
		return false;
	}
}
