import {
	availableContainerRuntimes,
	getContainerRuntimeAdapter,
	stopBuncargoContainers,
	withProjectLifecycleLock,
} from "../../container-runtime";
import { findMonorepoRoot } from "../../core/ports";
import {
	isProcessAlive,
	killPortOwner,
	signalProcessTree,
} from "../../core/process";
import { matchesProcessIdentity } from "../../core/process-identity";
import { askConfirm, isInteractive } from "../../core/prompt";
import {
	findRunsByRoot,
	patchRun,
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
	const runs = root
		? (await findRunsByRoot(root)).filter(
				(run) => !parsed.run || run.sessionId === parsed.run,
			)
		: [];
	if (runs.length === 0) {
		log.error(`No active buncargo run for ${root ?? "this directory"}.`);
		log.hint("Run `buncargo runs` to see what is active.");
		return STOP_EXIT.notFound;
	}

	if (parsed.all) {
		let result: number = STOP_EXIT.ok;
		for (const run of runs) {
			const code = await stopWholeRun(run, parsed.force);
			if (code !== STOP_EXIT.ok) result = code;
		}
		return result;
	}

	let exitCode: number = STOP_EXIT.ok;
	for (const name of parsed.names) {
		const run =
			runs.find((entry) =>
				entry.apps.some(
					(app) =>
						app.name === name &&
						app.pid !== undefined &&
						app.status !== "stopped",
				),
			) ??
			runs.find((entry) =>
				[...entry.apps, ...entry.services].some(
					(target) => target.name === name,
				),
			) ??
			runs[0];
		if (!run) continue;
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
	if (app) {
		const result = await stopApp(run, app, force);
		if (result === STOP_EXIT.ok)
			await patchRun(run.sessionId, {
				apps: [{ name: app.name, status: "stopped" }],
			});
		return result;
	}

	const service = run.services.find((entry) => entry.name === name);
	if (service) return stopService(run, service);

	log.error(`"${name}" is not an app or service of this run.`);
	log.hint(
		`Known: ${[...run.apps, ...run.services].map((entry) => entry.name).join(", ") || "(none)"}`,
	);
	return STOP_EXIT.notFound;
}

async function stopApp(
	run: RunEntry,
	app: RunAppEntry,
	force: boolean,
): Promise<number> {
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

	if (
		!matchesProcessIdentity(app.pid, app.processIdentity) ||
		(run.sessionId && !app.processIdentity)
	) {
		log.error(
			`${app.name}'s recorded process identity no longer matches. Refresh the run before stopping it.`,
		);
		return STOP_EXIT.refused;
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

	if (app.port === undefined) {
		log.error(`Stop ${app.name} from its owning run or use dev --takeover.`);
		return STOP_EXIT.refused;
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

	if (isProcessAlive(pid)) signalProcessTree(pid, "SIGKILL");
	const verifyDeadline = Date.now() + 1000;
	while (isProcessAlive(pid) && Date.now() < verifyDeadline)
		await sleep(TERM_POLL_MS);
	if (isProcessAlive(pid))
		throw new Error(`Process ${pid} did not exit after SIGKILL`);
}

/**
 * Stop a service's container.
 *
 * `stop`, never `kill`: a `restart:` policy honours the first and can undo the
 * second. Nothing in buncargo brings a stopped container back — the watchdog
 * only ever tears down — so the service stays down until the next `dev`.
 */
export async function stopService(
	run: RunEntry,
	service: RunServiceEntry,
): Promise<number> {
	return withProjectLifecycleLock(run.projectName, run.root, () =>
		stopServiceUnlocked(run, service),
	);
}

async function stopServiceUnlocked(
	run: RunEntry,
	service: RunServiceEntry,
): Promise<number> {
	// The entry records which backend started this service and the binary it
	// was started through, so there is nothing to probe for: asking every
	// available runtime was only ever a fallback for entries written before
	// the claim carried it.
	const runtimes = service.container
		? [
				getContainerRuntimeAdapter(service.container.runtime, {
					binary: service.container.binary,
				}),
			]
		: availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.error("No container runtime is running.");
		return STOP_EXIT.refused;
	}
	const serviceName = service.container?.service ?? service.name;
	try {
		const containers = runtimes
			.flatMap((runtime) => runtime.list())
			.filter(
				(container) =>
					container.project === run.projectName &&
					container.service === serviceName,
			);
		if (containers.length > 0) stopBuncargoContainers(containers, runtimes);
		// One service, one container, however many sessions are looking at it:
		// mark it stopped in each of theirs.
		const sharing = (await findRunsByRoot(run.root)).filter(
			(owner) =>
				owner.projectName === run.projectName &&
				owner.services.some((entry) => entry.name === service.name),
		);
		await Promise.all(
			sharing.map((owner) =>
				patchRun(owner.sessionId, {
					services: [{ name: service.name, status: "stopped" }],
				}),
			),
		);
		log.done(`Stopped ${service.name}`);
		return STOP_EXIT.ok;
	} catch (error) {
		log.error(
			`Could not stop ${service.name}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return STOP_EXIT.refused;
	}
}

/**
 * Stop everything this run owns.
 *
 * Signals the `buncargo dev` process rather than its children, so the run
 * performs its own teardown — releasing host routes, withdrawing its registry
 * entry, stopping tunnels — instead of being dismantled from outside. The
 * containers are removed here because that run releases them to the
 * watchdog's idle hold rather than stopping them itself, and "stop the run"
 * from the menu bar means now.
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

	if (
		!matchesProcessIdentity(run.pid, run.processIdentity) ||
		(run.sessionId && !run.processIdentity)
	) {
		log.error(
			"The recorded run process identity no longer matches. Refresh the run before stopping it.",
		);
		return STOP_EXIT.refused;
	}
	await terminate(run.pid);
	return withProjectLifecycleLock(run.projectName, run.root, async () => {
		// A second session in this checkout keeps the containers. It claims them
		// in this same registry before it starts them, so a run that is still
		// coming up is already visible here — which is what a separate liveness
		// record used to be needed for.
		const others = (await findRunsByRoot(run.root)).filter(
			(other) => other.pid !== run.pid && other.projectName === run.projectName,
		);
		if (others.length > 0) {
			log.done(
				`Stopped ${run.projectName}; services retained for another active run`,
			);
			return STOP_EXIT.ok;
		}
		const container = run.services.find(
			(service) => service.container,
		)?.container;
		const runtimes = container
			? [
					getContainerRuntimeAdapter(container.runtime, {
						binary: container.binary,
					}),
				]
			: availableContainerRuntimes();
		try {
			for (const runtime of runtimes)
				await runtime.down({
					root: run.root,
					projectName: run.projectName,
					verbose: false,
				});
		} catch (error) {
			log.error(
				`Could not remove ${run.projectName}'s containers: ${error instanceof Error ? error.message : String(error)}`,
			);
			return STOP_EXIT.refused;
		}
		log.done(`Stopped ${run.projectName}`);
		return STOP_EXIT.ok;
	});
}
