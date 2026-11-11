import { readProxyActivity } from "../../core/hosts/proxy-activity";
import { describeLeaseHolder, readLeases } from "../../core/leases";
import {
	describeIdleState,
	readIdleState,
	readRunConnections,
} from "../../core/run-limits";
import {
	groupRunsByProject,
	type RunEntry,
	readLiveRuns,
} from "../../core/run-registry";
import { BASE_EXITS, defineCommand } from "../command-spec";
import type { RunsJson } from "../json-documents";
import * as log from "../log";

/**
 * `buncargo runs` — what is running on this machine.
 *
 * The human-readable half of the run registry, and the answer to "why does the
 * menu bar not show my project": if it is not here, the app cannot see it
 * either. `--json` is the same data the app reads, after pruning.
 *
 * Unlike `ls` this needs no container runtime, so it answers instantly and
 * still works with `--no-docker-autostart` or a stopped Docker.
 */
async function showRuns(json: boolean): Promise<void> {
	const runs = await readLiveRuns();
	const leases = await readLeases().catch(() => []);
	const now = Date.now();
	const proxy = readProxyActivity(now);
	const connections = await readRunConnections(runs, now);

	if (json) {
		// `idleStopsAt`: when a detached run stops if nothing uses it first.
		const withLimits = runs.map((run) => {
			const idle = readIdleState(run, proxy, connections);
			return idle.kind === "counting"
				? { ...run, idleStopsAt: new Date(idle.stopsAt).toISOString() }
				: run;
		});
		log.line(
			JSON.stringify(
				{ version: 1, runs: withLimits, leases } satisfies RunsJson,
				null,
				2,
			),
		);
		return;
	}

	if (runs.length === 0) {
		log.info("No buncargo runs are active.");
		return;
	}

	for (const [project, entries] of groupRunsByProject(runs)) {
		log.line(project);
		for (const run of entries) {
			printRun(
				run,
				describeIdleState(readIdleState(run, proxy, connections), now),
			);
		}
		log.line();
	}

	if (leases.length > 0) {
		log.line("Leases");
		for (const lease of leases) {
			log.line(`  ${lease.key}: ${describeLeaseHolder(lease)}`);
		}
	}
}

function printRun(run: RunEntry, idle: string | undefined): void {
	const label = run.worktree ?? "main";
	const branch = run.branch ? `  (${run.branch})` : "";
	log.line(`  ${label}${branch}  pid ${run.pid}`);
	log.line(`    root: ${run.root}`);
	if (run.sessionId) log.line(`    run: ${run.sessionId}`);
	if (idle) log.line(`    detached: ${idle}`);

	for (const app of run.apps) {
		const primary = app.name === run.primaryApp ? " ←" : "";
		const owner = app.pid ? ` pid ${app.pid}` : "";
		log.line(
			`    app ${app.name}: ${app.status}${owner}  ${app.url ?? "worker"}${primary}`,
		);
		if (app.publicUrl) {
			log.line(`      public: ${app.publicUrl}`);
		}
		if (app.expo) {
			log.line(`      simulator: bunx buncargo expo sim ${app.name}`);
		}
		if (app.exclusive) {
			log.line(`      lease: ${app.exclusive}`);
		}
	}

	for (const service of run.services) {
		log.line(
			`    service ${service.name}: ${service.status}  ${service.url ?? "container"}`,
		);
	}
}

export const runsCommand = defineCommand({
	spec: {
		name: "runs",
		summary: "Show the dev runs active on this machine",
		flags: {
			json: {
				kind: "boolean",
				description: "Machine-readable view of every active run",
			},
		},
	},
	exits: BASE_EXITS,
	json: "RunsJson (--json)",
	run: async ({ values }) => {
		await showRuns(values.json);
		return 0;
	},
});
