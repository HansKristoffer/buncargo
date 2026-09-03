import {
	availableContainerRuntimes,
	listBuncargoContainers,
	stopBuncargoContainers,
} from "../../container-runtime";
import { findMonorepoRoot } from "../../core/ports";
import {
	isProcessAlive,
	killPortOwner,
	signalProcessTree,
} from "../../core/process";
import { askConfirm, isInteractive } from "../../core/prompt";
import {
	findRunByRoot,
	type RunAppEntry,
	type RunEntry,
	type RunServiceEntry,
} from "../../core/run-registry";
import { sleep } from "../../core/sleep";
import * as log from "../log";
import { parseStopArgs, printStopHelp } from "../stop-flags";

/**
 * `buncargo stop` — stop one app, one service, or a whole run.
 *
 * The menu bar app's kill buttons are this command; it never signals processes
 * or talks to Docker itself. Everything comes from the run registry, so this
 * loads no config and is safe to run from anywhere.
 *
 * Stopping one dev server does not end the run. A signalled exit reaches the
 * child supervisor with a null exit code, which is the one case it does not
 * treat as failure, so the other apps and the containers keep going.
 */

/** 0 stopped · 2 nothing matched · 3 refused. */
export const STOP_EXIT = { ok: 0, notFound: 2, refused: 3 } as const;

const TERM_GRACE_MS = 5000;
const TERM_POLL_MS = 100;

export async function handleStop(args: string[] = []): Promise<number> {
	const parsed = parseStopArgs(args);
	if (parsed.help) {
		printStopHelp();
		return STOP_EXIT.ok;
	}
	if (parsed.unknownFlags.length > 0) {
		log.error(`Unknown flag(s): ${parsed.unknownFlags.join(", ")}`);
		printStopHelp();
		return STOP_EXIT.refused;
	}
	for (const problem of parsed.errors) {
		log.error(problem);
	}
	if (parsed.errors.length > 0) return STOP_EXIT.refused;

	const root = parsed.root ?? safeMonorepoRoot();
	const run = root ? await findRunByRoot(root) : undefined;
	if (!run) {
		log.error(`No active buncargo run for ${root ?? "this directory"}.`);
		log.hint("Run `buncargo runs` to see what is active.");
		return STOP_EXIT.notFound;
	}

	if (parsed.all) {
		return stopWholeRun(run, parsed.force);
	}

	let exitCode: number = STOP_EXIT.ok;
	for (const name of parsed.names) {
		const code = await stopTarget(run, name, parsed.force);
		if (code !== STOP_EXIT.ok) exitCode = code;
	}
	return exitCode;
}

/**
 * The checkout we are standing in, if any.
 *
 * `findMonorepoRoot` walks up looking for a workspace marker and throws when
 * there is none. Outside a repo that is not an error here — it just means the
 * caller has to say `--root`.
 */
function safeMonorepoRoot(): string | undefined {
	try {
		return findMonorepoRoot();
	} catch {
		return undefined;
	}
}

async function stopTarget(
	run: RunEntry,
	name: string,
	force: boolean,
): Promise<number> {
	const app = run.apps.find((entry) => entry.name === name);
	if (app) return stopApp(app, force);

	const service = run.services.find((entry) => entry.name === name);
	if (service) return stopService(run, service);

	log.error(`"${name}" is not an app or service of this run.`);
	log.hint(
		`Known: ${[...run.apps, ...run.services].map((entry) => entry.name).join(", ") || "(none)"}`,
	);
	return STOP_EXIT.notFound;
}

async function stopApp(app: RunAppEntry, force: boolean): Promise<number> {
	if (app.status === "stopped") {
		log.info(`${app.name} is already stopped.`);
		return STOP_EXIT.ok;
	}

	// Closing the attached app is by design what tears the rest of the run
	// down, so it cannot be a plain "stop one thing".
	if (app.attached && !force) {
		const accepted =
			isInteractive() &&
			(await askConfirm([
				`  ${app.name} holds the terminal. Stopping it stops the whole run.`,
				"",
				"  y to stop the run  ·  Enter to leave it running",
			]));
		if (!accepted) {
			log.error(
				`${app.name} is the attached app; stopping it stops the whole run.`,
			);
			log.hint("Pass --force to do it anyway.");
			return STOP_EXIT.refused;
		}
	}

	if (app.pid === undefined) {
		return stopReusedApp(app, force);
	}

	await terminate(app.pid);
	log.done(`Stopped ${app.name}`);
	return STOP_EXIT.ok;
}

/**
 * An app this run reused rather than spawned.
 *
 * The process belongs to another terminal, so this is the takeover's kill path
 * and asks the same way before using it.
 */
async function stopReusedApp(
	app: RunAppEntry,
	force: boolean,
): Promise<number> {
	if (!force) {
		const accepted =
			isInteractive() &&
			(await askConfirm([
				`  ${app.name} on port ${app.port} was started by another terminal.`,
				"",
				"  y to stop it anyway  ·  Enter to leave it running",
			]));
		if (!accepted) {
			log.error(`${app.name} is served by a process this run did not start.`);
			log.hint("Pass --force to stop whatever is holding the port.");
			return STOP_EXIT.refused;
		}
	}

	const released = await killPortOwner(app.port, { verbose: false });
	if (!released) {
		log.error(`Could not free port ${app.port} for ${app.name}.`);
		return STOP_EXIT.refused;
	}
	log.done(`Stopped ${app.name}`);
	return STOP_EXIT.ok;
}

/**
 * SIGTERM the process group, then SIGKILL what is left.
 *
 * The group, not the pid: a dev command is usually a shell that spawns the real
 * server, and signalling only the parent leaves the server holding the port.
 */
async function terminate(pid: number): Promise<void> {
	if (!isProcessAlive(pid)) return;
	signalProcessTree(pid, "SIGTERM");

	const deadline = Date.now() + TERM_GRACE_MS;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await sleep(TERM_POLL_MS);
	}

	if (isProcessAlive(pid)) {
		signalProcessTree(pid, "SIGKILL");
	}
}

/**
 * Stop a service's container.
 *
 * `stop`, never `kill`: a `restart:` policy honours the first and can undo the
 * second. Nothing in buncargo brings a stopped container back — the watchdog
 * only ever tears down — so the service stays down until the next `dev`.
 */
function stopService(run: RunEntry, service: RunServiceEntry): number {
	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.error("No container runtime is running.");
		return STOP_EXIT.refused;
	}

	// Resolved by label rather than from the registry's recorded name: compose
	// and the Apple backend name containers differently, and the labels are
	// what both of them write.
	const containers = listBuncargoContainers(runtimes).filter(
		(container) =>
			container.project === run.projectName &&
			(container.service === service.name ||
				container.name.includes(`-${service.name}-`)),
	);

	if (containers.length === 0) {
		log.info(`No running container for ${service.name}.`);
		return STOP_EXIT.ok;
	}

	stopBuncargoContainers(containers, runtimes);
	log.done(`Stopped ${service.name}`);
	return STOP_EXIT.ok;
}

/**
 * Stop everything this run owns.
 *
 * Signals the `buncargo dev` process rather than its children, so the run
 * performs its own teardown — releasing host routes, withdrawing its registry
 * entry, stopping tunnels — instead of being dismantled from outside. The
 * containers are stopped here because that run hands them to the watchdog's
 * idle backstop rather than stopping them itself.
 */
async function stopWholeRun(run: RunEntry, force: boolean): Promise<number> {
	if (!force) {
		const accepted =
			isInteractive() &&
			(await askConfirm([
				`  Stop ${run.projectName}? This kills dev servers in another terminal.`,
				"",
				"  y to stop it  ·  Enter to leave it running",
			]));
		if (!accepted) {
			log.error(`Refusing to stop ${run.projectName} without confirmation.`);
			log.hint("Pass --force to stop it anyway.");
			return STOP_EXIT.refused;
		}
	}

	await terminate(run.pid);

	const runtimes = availableContainerRuntimes();
	if (runtimes.length > 0) {
		const containers = listBuncargoContainers(runtimes).filter(
			(container) => container.project === run.projectName,
		);
		if (containers.length > 0) {
			stopBuncargoContainers(containers, runtimes);
		}
	}

	log.done(`Stopped ${run.projectName}`);
	return STOP_EXIT.ok;
}
