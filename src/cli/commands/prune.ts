import {
	availableContainerRuntimes,
	listBuncargoContainers,
	orphanedVolumes,
	planVolumePrune,
	sweepOrphanedContainers,
	type VolumeReport,
} from "../../container-runtime";
import { askConfirm, isInteractive } from "../../core/prompt";
import { readAllRuns } from "../../core/run-registry";
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
