import {
	availableContainerRuntimes,
	buncargoContainersOn,
	type ContainerRuntimeAdapter,
	claimedCheckouts,
	type GcClaimItem,
	type GcStackItem,
	listBuncargoContainers,
	planGc,
	planVolumePrune,
	stackLastActivityAt,
	staleDeletedClaims,
	sweepOrphanedContainers,
	type VolumeReport,
	withProjectLifecycleLock,
} from "../../container-runtime";
import { checkoutPresence } from "../../core/checkout-presence";
import { FileLockTimeoutError } from "../../core/file-lock";
import { readProxyActivity } from "../../core/hosts/proxy-activity";
import {
	dropDeletedOffsetClaims,
	type OffsetClaim,
	offsetClaimRoot,
	readAllOffsetClaims,
} from "../../core/offset-claims";
import { askConfirm, isInteractive } from "../../core/prompt";
import { StateFileUnreadableError } from "../../core/registry-file";
import { recordEvents, removalActor } from "../../core/removal-log";
import { lastCheckoutCommandAt } from "../../core/run-activity";
import {
	readAllRuns,
	retireRuns,
	runLivenessAsync,
} from "../../core/run-registry";
import { DETACHED_IDLE_LIMIT_MS } from "../../core/watchdog-constants";
import type { BuncargoContainer, BuncargoVolume } from "../../types";
import { defineCommand } from "../command-spec";
import { parseIdleDuration } from "../duration";
import type { GcJson } from "../json-documents";
import * as log from "../log";

export const gcCommand = defineCommand({
	spec: {
		name: "gc",
		summary:
			"Stop orphaned stacks, prune deleted checkouts' volumes and drop stale port claims",
		flags: {
			"dry-run": {
				kind: "boolean",
				description: "List what would be stopped or removed and stop",
			},
			yes: {
				kind: "boolean",
				description:
					"Remove deleted checkouts' volumes without prompting (for scripts and cron)",
			},
			idle: {
				kind: "string",
				value: "<duration>",
				description:
					"Stop unowned stacks idle at least this long, e.g. 2h, 30m, 1d (default: 2h)",
				validate: (value: string) =>
					parseIdleDuration(value) === undefined
						? `--idle takes a duration such as 2h, 30m or 1d (a bare number is days): got "${value}".`
						: undefined,
			},
			json: {
				kind: "boolean",
				description: "One JSON document on stdout",
			},
		},
		examples: [
			{
				command: "bunx buncargo gc --dry-run",
				description:
					"Preview orphaned stacks, deleted-checkout volumes and stale claims",
			},
			{
				command: "bunx buncargo gc --yes",
				description:
					"Stop orphaned stacks, remove deleted checkouts' volumes and prune stale claims (for cron)",
			},
		],
	},
	exits: {
		0: "cleaned, listed (--dry-run), or nothing to clean",
		1: "a removal failed, offsets.json or runs.json is unreadable, or bad arguments",
	},
	json: "GcJson (--json)",
	run: ({ values }) => {
		const parsedIdle =
			values.idle !== undefined ? parseIdleDuration(values.idle) : undefined;
		const idleMs = parsedIdle ? parsedIdle.ms : DETACHED_IDLE_LIMIT_MS;
		return runGc({
			dryRun: values["dry-run"],
			yes: values.yes,
			idleMs,
			json: values.json,
		});
	},
});

interface GcRequest {
	dryRun: boolean;
	yes: boolean;
	idleMs: number;
	json: boolean;
}

function readClaimsStrict(): Record<string, OffsetClaim> | undefined {
	try {
		return readAllOffsetClaims({ strict: true });
	} catch (error) {
		if (!(error instanceof StateFileUnreadableError)) throw error;
		log.error(`${error.message}. Nothing was removed.`);
		return undefined;
	}
}

async function listRuntimeInventory(
	runtimes: readonly ContainerRuntimeAdapter[],
): Promise<{
	answered: ContainerRuntimeAdapter[];
	containers: BuncargoContainer[];
	volumes: BuncargoVolume[];
}> {
	const answered: ContainerRuntimeAdapter[] = [];
	const containers: BuncargoContainer[] = [];
	const volumes: BuncargoVolume[] = [];

	for (const runtime of runtimes) {
		try {
			const [listedContainers, listedVolumes] = await Promise.all([
				buncargoContainersOn(runtime),
				runtime.listVolumes(),
			]);
			containers.push(...listedContainers);
			volumes.push(...listedVolumes);
			answered.push(runtime);
		} catch {
			// A runtime that does not answer is omitted so nothing guesses from silence.
		}
	}

	return { answered, containers, volumes };
}

async function runGc(request: GcRequest): Promise<number> {
	const claims = readClaimsStrict();
	if (!claims) return 1;

	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		const empty: GcJson = {
			dryRun: request.dryRun,
			stacks: [],
			volumes: [],
			claims: [],
			skippedVolumes: 0,
			failed: [],
		};
		if (request.json) log.line(JSON.stringify(empty, null, 2));
		else log.info("No container runtime is running. Nothing to clean.");
		return 0;
	}

	if (request.dryRun) return runDryGc(request, runtimes, claims);
	return runLiveGc(request, runtimes, claims);
}

async function runDryGc(
	request: GcRequest,
	runtimes: readonly ContainerRuntimeAdapter[],
	claims: Record<string, OffsetClaim>,
): Promise<number> {
	const now = Date.now();
	const { answered, containers, volumes } =
		await listRuntimeInventory(runtimes);
	if (answered.length === 0) {
		const empty: GcJson = {
			dryRun: true,
			stacks: [],
			volumes: [],
			claims: [],
			skippedVolumes: 0,
			failed: [],
		};
		if (request.json) log.line(JSON.stringify(empty, null, 2));
		else log.info("No container runtime answered. Nothing to clean.");
		return 0;
	}

	const runs = await readAllRuns();
	const alive = await runLivenessAsync(runs);
	const proxy = readProxyActivity(now);
	const plan = planGc({
		containers,
		volumes,
		runs,
		alive,
		claims,
		checkoutPresence,
		lastActivityAt: (group) =>
			stackLastActivityAt(
				group,
				claims,
				proxy,
				lastCheckoutCommandAt(group.root),
			),
		now,
		idleLimitMs: request.idleMs,
	});

	const document: GcJson = {
		dryRun: true,
		stacks: plan.stacks,
		volumes: plan.volumes.map((volume) => ({ ...volume, removed: false })),
		claims: plan.claims,
		skippedVolumes: 0,
		failed: [],
	};
	reportGc(document, request.json);
	return 0;
}

async function runLiveGc(
	request: GcRequest,
	runtimes: ContainerRuntimeAdapter[],
	claimsBefore: Record<string, OffsetClaim>,
): Promise<number> {
	const now = Date.now();
	const actor = removalActor("buncargo gc");
	const swept = await sweepOrphanedContainers({
		runtimes,
		now,
		actor,
		unownedIdleLimitMs: request.idleMs,
	});
	const answered = runtimes.filter((runtime) =>
		swept.answered.includes(runtime.name),
	);
	const failed: GcJson["failed"] = swept.failed.map((item) => ({
		target: `${item.projectName} (${item.root})`,
		error: item.error,
	}));
	const stacks: GcStackItem[] = [];
	const volumeResults: GcJson["volumes"] = [];
	for (const item of swept.swept) {
		if (item.volumes) {
			for (const name of item.volumes) {
				volumeResults.push({
					name,
					project: item.projectName,
					runtime: item.runtime,
					root: item.root,
					reason: item.reason,
					removed: true,
				});
			}
			continue;
		}
		stacks.push({
			projectName: item.projectName,
			root: item.root,
			runtime: item.runtime,
			reason: item.reason,
		});
	}

	if (answered.length === 0) {
		const document: GcJson = {
			dryRun: false,
			stacks,
			volumes: volumeResults,
			claims: [],
			skippedVolumes: 0,
			failed,
		};
		reportGc(document, request.json);
		return failed.length > 0 ? 1 : 0;
	}

	// `sweepOrphanedContainers` retires entries on the pass *after* their
	// containers disappear. Confirm from a fresh listing here so dead entries
	// whose stacks `gc` just downed do not block volume pruning until a second
	// `gc` run.
	if (stacks.length > 0) {
		const postSweepContainers = await listBuncargoContainers(answered);
		const postSweepRuns = await readAllRuns();
		const postSweepAlive = await runLivenessAsync(postSweepRuns);
		const retired = postSweepRuns.filter(
			(run) =>
				!postSweepAlive(run) &&
				(run.stacks?.length ?? 0) === 0 &&
				!postSweepContainers.some(
					(container) =>
						container.project === run.projectName &&
						container.root === run.root,
				),
		);
		await retireRuns(retired).catch(() => {});
	}

	const volumeInventory = async (): Promise<VolumeReport[] | undefined> => {
		const listedClaims = readClaimsStrict();
		if (!listedClaims) return undefined;
		const listedVolumes = (
			await Promise.all(answered.map((runtime) => runtime.listVolumes()))
		).flat();
		return planVolumePrune({
			volumes: listedVolumes,
			containers: await listBuncargoContainers(answered),
			runs: await readAllRuns(),
			checkouts: claimedCheckouts(listedClaims),
		});
	};

	const reports = await volumeInventory();
	if (!reports) return 1;

	const proposed = reports.filter(
		(report) => report.verdict.kind === "orphaned",
	);
	let skippedVolumes = 0;

	if (proposed.length > 0) {
		// Immediate volume deletion (without the 10-minute settle window) always
		// requires explicit confirmation or `--yes`, even when
		// `BUNCARGO_PRUNE_DELETED_CHECKOUTS=1` is set on the machine.
		let shouldRemove = request.yes;
		const canPrompt = !shouldRemove && !request.json && isInteractive();
		if (canPrompt) {
			log.line();
			log.info(
				`${plural(proposed.length, "volume")} of deleted checkouts, with no containers and no run:`,
			);
			for (const { volume, verdict } of proposed) {
				log.line(`  ${volume.name}  (${volume.project}: ${verdict.reason})`);
			}
			log.line();
			log.warn("Removing these destroys their data, databases included.");
			shouldRemove = await askConfirm([
				`  Remove ${plural(proposed.length, "volume")}? This cannot be undone.`,
				"",
				"  y to remove  ·  Enter to keep them",
			]);
		}

		if (!shouldRemove) {
			skippedVolumes = proposed.length;
			for (const { volume, verdict } of proposed) {
				if (verdict.kind !== "orphaned") continue;
				volumeResults.push({
					name: volume.name,
					project: volume.project ?? "",
					runtime: volume.runtime,
					root: verdict.root,
					reason: verdict.reason,
					removed: false,
				});
			}
		} else {
			const projects = new Set(proposed.map(({ volume }) => volume.project));
			for (const project of projects) {
				const projectReports = proposed.filter(
					({ volume }) => volume.project === project,
				);
				await removeProjectVolumes(
					answered,
					projectReports,
					volumeInventory,
					actor,
					volumeResults,
					failed,
				);
			}
		}
	}

	const freshClaims = readClaimsStrict();
	if (!freshClaims) return 1;
	const freshRuns = await readAllRuns();
	const freshContainers = await listBuncargoContainers(answered);
	const freshVolumes = (
		await Promise.all(answered.map((runtime) => runtime.listVolumes()))
	).flat();
	const staleClaims: GcClaimItem[] = staleDeletedClaims({
		claims: freshClaims,
		checkoutPresence,
		remainingRuns: freshRuns,
		remainingContainers: freshContainers,
		remainingVolumes: freshVolumes,
	});
	await dropDeletedOffsetClaims(staleClaims.map((claim) => claim.key));

	// Include deleted claims settled during the sweep pass as well as those
	// dropped after volume removal.
	const claimsAfter = readClaimsStrict();
	if (!claimsAfter) return 1;
	const prunedClaims: GcClaimItem[] = Object.entries(claimsBefore)
		.filter(([key, claim]) => {
			if (key in claimsAfter) return false;
			return checkoutPresence(offsetClaimRoot(key, claim)) === "deleted";
		})
		.map(([key, claim]) => ({
			key,
			root: offsetClaimRoot(key, claim),
			projectName: claim.projectName,
			offset: claim.offset,
			reason: "checkout deleted",
		}))
		.sort((a, b) => a.offset - b.offset || a.key.localeCompare(b.key));

	const document: GcJson = {
		dryRun: false,
		stacks,
		volumes: volumeResults,
		claims: prunedClaims,
		skippedVolumes,
		failed,
	};
	reportGc(document, request.json);
	return failed.length > 0 ? 1 : 0;
}

async function removeProjectVolumes(
	runtimes: readonly ContainerRuntimeAdapter[],
	listed: readonly VolumeReport[],
	inventory: () => Promise<VolumeReport[] | undefined>,
	actor: ReturnType<typeof removalActor>,
	results: GcJson["volumes"],
	failed: GcJson["failed"],
): Promise<void> {
	const [first] = listed;
	if (!first || first.verdict.kind !== "orphaned") return;
	const project = first.volume.project ?? "";
	const root = first.verdict.root;

	try {
		await withProjectLifecycleLock(
			project,
			root,
			async () => {
				const fresh = await inventory();
				if (!fresh) return;

				for (const runtime of runtimes) {
					const matching = listed.filter(
						({ volume }) => volume.runtime === runtime.name,
					);
					const confirmed = matching.filter(({ volume }) => {
						const now = fresh.find(
							(report) =>
								report.volume.name === volume.name &&
								report.volume.runtime === volume.runtime,
						);
						return now?.verdict.kind === "orphaned";
					});
					if (confirmed.length === 0) continue;

					const names = confirmed.map(({ volume }) => volume.name);
					const refused = await runtime.removeVolumes(names);
					for (const item of refused) {
						failed.push({ target: `volume ${item.name}`, error: item.error });
					}
					const refusedNames = new Set(refused.map((item) => item.name));
					const removedNames: string[] = [];

					for (const { volume, verdict } of confirmed) {
						if (verdict.kind !== "orphaned") continue;
						const removed = !refusedNames.has(volume.name);
						if (removed) removedNames.push(volume.name);
						results.push({
							name: volume.name,
							project,
							runtime: volume.runtime,
							root: verdict.root,
							reason: verdict.reason,
							removed,
						});
					}

					if (removedNames.length > 0) {
						await recordEvents([
							{
								kind: "volumes",
								at: new Date().toISOString(),
								projectName: project,
								root,
								runtime: runtime.name,
								reason: `checkout deleted, removed volumes ${removedNames.join(", ")}`,
								volumes: removedNames,
								by: actor,
							},
						]);
					}
				}
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError)) throw error;
		// Busy lock means a run is starting or stopping this project: skip it,
		// matching `sweep` and `prune`.
	}
}

function reportGc(document: GcJson, json: boolean): void {
	if (json) {
		log.line(JSON.stringify(document, null, 2));
		return;
	}

	const { dryRun, stacks, volumes, claims, skippedVolumes, failed } = document;
	const removedVolumes = volumes.filter((volume) => volume.removed);
	const listedVolumes = dryRun ? volumes : removedVolumes;
	const nothingToReport =
		stacks.length === 0 &&
		listedVolumes.length === 0 &&
		claims.length === 0 &&
		skippedVolumes === 0 &&
		failed.length === 0;

	if (nothingToReport) {
		log.info("Nothing to clean.");
		return;
	}

	const verb = dryRun ? "Would stop" : "Stopped";
	if (stacks.length > 0) {
		log.info(`${verb} ${plural(stacks.length, "orphaned stack")}:`);
		for (const stack of stacks) {
			log.line(
				`  ${stack.projectName}  (${stack.root}, ${stack.runtime}: ${stack.reason})`,
			);
		}
	}

	const volumeVerb = dryRun ? "Would remove" : "Removed";
	if (listedVolumes.length > 0) {
		log.info(
			`${volumeVerb} ${plural(listedVolumes.length, "volume")} of deleted checkouts:`,
		);
		for (const volume of listedVolumes) {
			log.line(`  ${volume.name}  (${volume.project}: ${volume.reason})`);
		}
	}

	const claimVerb = dryRun ? "Would prune" : "Pruned";
	if (claims.length > 0) {
		log.info(`${claimVerb} ${plural(claims.length, "stale port claim")}:`);
		for (const claim of claims) {
			log.line(
				`  offset ${claim.offset}  ${claim.root} (${claim.projectName}: ${claim.reason})`,
			);
		}
	}

	if (skippedVolumes > 0) {
		log.hint(
			`Kept ${plural(skippedVolumes, "volume")} of deleted checkouts without confirmation; pass --yes to remove them.`,
		);
	}
	for (const failure of failed) {
		log.warn(`Could not clean ${failure.target}: ${failure.error}`);
	}
	if (dryRun) {
		log.hint("Run without --dry-run (and --yes for volumes) to apply.");
	}
}

function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
