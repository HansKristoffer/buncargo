import { describeLeaseHolder, readLeases } from "../../core/leases";
import {
	groupRunsByProject,
	type RunEntry,
	readLiveRuns,
} from "../../core/run-registry";
import { hasFlag } from "../flags";
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
export async function handleRuns(args: string[] = []): Promise<void> {
	const runs = await readLiveRuns();
	const leases = await readLeases().catch(() => []);

	if (hasFlag(args, "--json")) {
		log.line(JSON.stringify({ version: 1, runs, leases }, null, 2));
		return;
	}

	if (runs.length === 0) {
		log.info("No buncargo runs are active.");
		return;
	}

	for (const [project, entries] of groupRunsByProject(runs)) {
		log.line(project);
		for (const run of entries) {
			printRun(run);
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

function printRun(run: RunEntry): void {
	const label = run.worktree ?? "main";
	const branch = run.branch ? `  (${run.branch})` : "";
	log.line(`  ${label}${branch}  pid ${run.pid}`);
	log.line(`    root: ${run.root}`);
	if (run.sessionId) log.line(`    run: ${run.sessionId}`);

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
			log.line(`      simulator: bunx buncargo sim ${app.name}`);
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
