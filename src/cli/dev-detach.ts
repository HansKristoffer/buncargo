import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logsRoot } from "../core/process/app-logs";
import {
	findRunsByRoot,
	type RunAppEntry,
	type RunEntry,
} from "../core/run-registry";
import { sleep } from "../core/sleep";
import * as log from "./log";

/**
 * `buncargo dev --detach`: the run in the background, the terminal back once
 * its apps are up.
 *
 * Agents ran `nohup buncargo dev & disown` because their harness kills a
 * foreground command after a few minutes, then polled with `sleep` and `until
 * grep`. Here the run is re-executed in its own session (so neither the
 * harness's SIGTERM nor a closed terminal reaches it) and this process waits
 * on the run registry - the same record `wait`, `stop` and BuncargoBar read -
 * until every app has settled.
 */

const POLL_MS = 250;

/** Where a detached run's own output goes; app output is in its run directory. */
export function detachedLogPath(root: string): string {
	return join(logsRoot(root), "detached.log");
}

/**
 * Argv for the background run: this same invocation without `--detach`, so a
 * script wrapping `runCli` is re-run the same way `buncargo dev` is.
 */
export function detachedArgv(
	argv: readonly string[],
	execPath = process.execPath,
): string[] {
	return [execPath, ...argv.slice(1).filter((arg) => arg !== "--detach")];
}

/**
 * Every app has settled: up, or down for good. A config without apps settles
 * once its services are ready. `expectApps` matters because the run's first
 * claim is written before its apps are, and an empty list is not "done".
 */
export function settledRun(run: RunEntry, expectApps: boolean): boolean {
	if (expectApps)
		return (
			run.apps.length > 0 && run.apps.every((app) => app.status !== "starting")
		);
	return run.services.every((service) => service.status === "ready");
}

function describeApp(app: RunAppEntry): string {
	return `${app.name}: ${app.status}${app.openUrl ? `  ${app.openUrl}` : ""}`;
}

function tail(path: string, lines = 30): string {
	try {
		return readFileSync(path, "utf8")
			.trimEnd()
			.split("\n")
			.slice(-lines)
			.join("\n");
	} catch {
		return "";
	}
}

/**
 * Start the run in the background and wait for it. 0 when every app came up,
 * 1 when the run ended or an app failed (the others keep running).
 */
export async function runDetached(input: {
	root: string;
	/** Whether the config has apps to wait for (see {@link settledRun}). */
	expectApps: boolean;
	argv?: readonly string[];
	timeoutMs?: number;
}): Promise<number> {
	const { root, expectApps, timeoutMs = 10 * 60_000 } = input;
	const argv = detachedArgv(input.argv ?? process.argv);
	const logPath = detachedLogPath(root);
	mkdirSync(logsRoot(root), { recursive: true });
	const out = openSync(logPath, "w");
	const child = Bun.spawn(argv, {
		cwd: process.cwd(),
		stdio: ["ignore", out, out],
		detached: true,
		env: process.env,
	});
	closeSync(out);
	child.unref();

	let exited: number | undefined;
	void child.exited.then((code) => {
		exited = code;
	});

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const run = (await findRunsByRoot(root).catch(() => [])).find(
			(entry) => entry.pid === child.pid,
		);
		if (run && settledRun(run, expectApps)) {
			const down = run.apps.filter(
				(app) => app.status === "failed" || app.status === "stopped",
			);
			for (const app of run.apps) log.line(`  ${describeApp(app)}`);
			log.line(`  pid ${child.pid} · output: ${logPath}`);
			if (down.length === 0) {
				log.success(
					"Running in the background. Stop it with `buncargo stop --all --force`.",
				);
				return 0;
			}
			log.error(
				`${down.map((app) => app.name).join(", ")} did not come up; the other apps keep running.`,
			);
			for (const app of down) log.hint(`buncargo logs ${app.name} --errors`);
			return 1;
		}
		if (exited !== undefined) {
			log.error(`The run exited with code ${exited} before its apps came up.`);
			const output = tail(logPath);
			if (output) log.line(output);
			return 1;
		}
		if (Date.now() >= deadline) {
			log.error(
				`Apps still starting after ${Math.round(timeoutMs / 1000)}s; the run keeps going (pid ${child.pid}).`,
			);
			log.hint(`Follow it: buncargo logs -f · output: ${logPath}`);
			return 1;
		}
		await sleep(POLL_MS);
	}
}
