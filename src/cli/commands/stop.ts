import {
	type ContainerRuntimeAdapter,
	getContainerRuntimeAdapter,
	stopBuncargoContainers,
	withProjectLifecycleLock,
} from "../../container-runtime";
import { runStackDowns } from "../../container-runtime/sweep";
import { findMonorepoRoot } from "../../core/ports";
import { killPortOwner } from "../../core/process";
import {
	ProcessIdentityUnreadable,
	terminateProcessGroup,
} from "../../core/process/terminate";
import { askConfirm, isInteractive } from "../../core/prompt";
import {
	recordRemovals,
	removalActor,
	removalOwner,
} from "../../core/removal-log";
import {
	findCheckoutRuns,
	findRunsByRoot,
	patchRun,
	type RunAppEntry,
	type RunEntry,
	type RunServiceEntry,
	retireRuns,
} from "../../core/run-registry";

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

	const root = parsed.root ?? findMonorepoRoot();
	const selected = (run: RunEntry) =>
		!parsed.run || run.sessionId === parsed.run;
	const checkout = await findCheckoutRuns(root);
	const runs = checkout.live.filter(selected);
	// A finished run's apps are gone, so only its services are targets.
	const held = checkout.held
		.filter(selected)
		.map((run) => ({ ...run, apps: [] }));
	if (runs.length === 0 && held.length === 0) {
		log.error(`No active buncargo run for ${root}.`);
		log.hint("Run `buncargo runs` to see what is active.");
		return STOP_EXIT.notFound;
	}

	if (parsed.all) {
		let result: number = STOP_EXIT.ok;
		for (const run of runs) {
			const code = await stopWholeRun(run, parsed.force);
			if (code !== STOP_EXIT.ok) result = code;
		}
		// A run left standing was declined or could not be stopped: its
		// checkout's other leftovers are not this command's to judge then.
		if (result !== STOP_EXIT.ok) return result;
		// Read again: a stopped run has retired its own entry, or released it
		// when another run keeps its containers.
		const finished =
			runs.length === 0
				? held
				: (await findCheckoutRuns(root)).held.filter(selected);
		const byProject = Map.groupBy(finished, (run) => run.projectName);
		for (const [projectName, entries] of byProject) {
			const code = await stopHeldProject(root, projectName, entries);
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
			[...runs, ...held].find((entry) =>
				[...entry.apps, ...entry.services].some(
					(target) => target.name === name,
				),
			) ??
			runs[0] ??
			held[0];
		if (!run) continue;
		const code = await stopTarget(run, name, parsed.force);
		if (code !== STOP_EXIT.ok) exitCode = code;
	}
	return exitCode;
}

export async function stopTarget(
	run: RunEntry,
	name: string,
	force: boolean,
): Promise<number> {
	const app = run.apps.find((entry) => entry.name === name);
	if (app) {
		const result = await stopApp(app, force);
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

	const stopped =
		app.processIdentity &&
		(await terminateUnlessUnreadable(
			`${app.name}'s process`,
			app.pid,
			app.processIdentity,
			app.stopGraceMs ?? DEFAULT_GRACE_MS,
		));
	if (stopped === "refused") return STOP_EXIT.refused;
	if (!stopped) {
		log.error(
			`${app.name}'s process (pid ${app.pid}) has exited or was replaced; nothing was signalled.`,
		);
		log.hint("Run `buncargo runs` to see the current run.");
		return STOP_EXIT.refused;
	}
	log.done(`Stopped ${app.name}`);
	return STOP_EXIT.ok;
}

/** How long `stop` waits after SIGTERM for an app that sets no `stopGraceMs`. */
const DEFAULT_GRACE_MS = 5000;

/**
 * How long a whole run gets before its `dev` process is killed.
 *
 * That process stops its apps itself, each with its own `stopGraceMs`, so it
 * needs the longest of them on top of its own teardown. Killing it sooner
 * leaves an app that is still saving data with no one to finish stopping it.
 */
export function runStopGraceMs(run: Pick<RunEntry, "apps">): number {
	return (
		DEFAULT_GRACE_MS +
		Math.max(0, ...run.apps.map((app) => app.stopGraceMs ?? 0))
	);
}

/**
 * {@link terminateProcessGroup}, refusing when the process's identity cannot
 * be read: it may still run, so it is neither reported stopped nor gone.
 */
async function terminateUnlessUnreadable(
	what: string,
	pid: number,
	identity: string,
	graceMs: number,
): Promise<boolean | "refused"> {
	try {
		return await terminateProcessGroup(pid, identity, graceMs);
	} catch (error) {
		if (!(error instanceof ProcessIdentityUnreadable)) throw error;
		log.error(`${what}: ${error.message}.`);
		log.hint(
			`Check it with \`ps -p ${pid}\` and run \`buncargo stop\` again, or stop pid ${pid} yourself.`,
		);
		return "refused";
	}
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
	// Its stack's CLI runs it as part of a whole; one piece cannot be stopped.
	if (service.stack) {
		log.error(
			`${service.name} is part of the ${service.stack} stack; stop the run to stop it.`,
		);
		return STOP_EXIT.refused;
	}
	return withProjectLifecycleLock(run.projectName, run.root, () =>
		stopServiceUnlocked(run, service),
	);
}

async function stopServiceUnlocked(
	run: RunEntry,
	service: RunServiceEntry,
): Promise<number> {
	// The entry records which backend started this service and the binary it
	// was started through. Only that: probing every runtime for the project
	// reaches containers this entry never recorded.
	if (!service.container) {
		log.error(
			`${run.projectName}'s entry records no container for ${service.name}; nothing was stopped.`,
		);
		log.hint("Stop the whole run with `buncargo stop --all`.");
		return STOP_EXIT.refused;
	}
	const runtimes = [
		getContainerRuntimeAdapter(service.container.runtime, {
			binary: service.container.binary,
		}),
	];
	const serviceName = service.container.service;
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
	// A detached run has no terminal showing its servers: there is nobody to
	// warn, and asking only taught agents to pass --force everywhere.
	if (!force && !run.detached) {
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

	const stopped =
		run.processIdentity &&
		(await terminateUnlessUnreadable(
			`${run.projectName}'s run process`,
			run.pid,
			run.processIdentity,
			runStopGraceMs(run),
		));
	if (stopped === "refused") return STOP_EXIT.refused;
	if (!stopped) {
		log.error(
			`${run.projectName}'s run process (pid ${run.pid}) has exited or was replaced; nothing was signalled.`,
		);
		log.hint("Run `buncargo runs` to see what is active.");
		return STOP_EXIT.refused;
	}
	return withProjectLifecycleLock(run.projectName, run.root, async () => {
		// A second session in this checkout keeps the containers. It claims them
		// in this same registry before it starts them, so a run that is still
		// coming up is already visible here — which is what a separate liveness
		// record used to be needed for.
		const { live, held } = await findCheckoutRuns(run.root);
		const others = live.filter(
			(other) => other.pid !== run.pid && other.projectName === run.projectName,
		);
		if (others.length > 0) {
			log.done(
				`Stopped ${run.projectName}; services retained for another active run`,
			);
			return STOP_EXIT.ok;
		}
		// Only what the entry records. A run with no container of its own (an
		// app-only run) has none to take down: probing every runtime for its
		// project used to `down` a stack another run had left in its idle hold.
		// The project's finished runs whose containers all come down with these
		// hold nothing afterwards, so they retire with it.
		const mine = new Set(containerKeys(run));
		const sharing = held.filter(
			(other) =>
				mine.size > 0 &&
				other.sessionId !== run.sessionId &&
				other.projectName === run.projectName &&
				containerKeys(other).every((key) => mine.has(key)),
		);
		if (!(await tearDown(run.root, run.projectName, [run, ...sharing])))
			return STOP_EXIT.refused;
		log.done(`Stopped ${run.projectName}`);
		return STOP_EXIT.ok;
	});
}

/**
 * Take down the containers finished runs of one project left: released into
 * the idle hold, or crashed inside the grace. Nobody is watching them, so
 * nothing is asked; a live run of the project in this checkout keeps them,
 * exactly as it would keep a stopped run's.
 */
async function stopHeldProject(
	root: string,
	projectName: string,
	held: readonly RunEntry[],
): Promise<number> {
	return withProjectLifecycleLock(projectName, root, async () => {
		// Read again under the lock: a run may have claimed these since.
		const fresh = await findCheckoutRuns(root);
		if (fresh.live.some((run) => run.projectName === projectName)) {
			log.info(
				`Kept ${projectName}'s containers: another run in ${root} uses them.`,
			);
			return STOP_EXIT.ok;
		}
		// An entry that records neither a container nor a stack names nothing to
		// take down, and retiring it would hide whatever it held from the sweep.
		const sessions = new Set(held.map((run) => run.sessionId));
		const entries = fresh.held.filter(
			(run) =>
				sessions.has(run.sessionId) &&
				(run.stacks?.length || run.services.some((s) => s.container)),
		);
		if (entries.length === 0) return STOP_EXIT.ok;
		if (!(await tearDown(root, projectName, entries))) return STOP_EXIT.refused;
		log.done(`Stopped ${projectName}'s containers, left by a finished run`);
		return STOP_EXIT.ok;
	});
}

/**
 * `down` the project on every runtime the entries record, stop their
 * integration stacks, then retire the entries: nothing is left to hold.
 * False, retiring nothing, when a teardown failed.
 */
async function tearDown(
	root: string,
	projectName: string,
	runs: readonly RunEntry[],
): Promise<boolean> {
	const removed: string[] = [];
	try {
		for (const runtime of recordedRuntimes(runs)) {
			await runtime.down({ root, projectName, verbose: false });
			removed.push(runtime.name);
		}
		for (const run of runs)
			await runStackDowns(run, (stack) => void removed.push(stack.name));
	} catch (error) {
		log.error(
			`Could not remove ${projectName}'s containers: ${error instanceof Error ? error.message : String(error)}`,
		);
		log.hint("Fix the runtime and run `buncargo stop --all` again.");
		return false;
	} finally {
		const at = new Date().toISOString();
		const by = removalActor();
		await recordRemovals(
			removed.map((runtime) => ({
				at,
				projectName,
				root,
				runtime,
				reason: "stopped",
				owner: removalOwner(runs[0]),
				by,
			})),
		);
	}
	await retireRuns(runs.map((run) => run.sessionId));
	return true;
}

/** One adapter per runtime and binary the entries' containers were started through. */
function recordedRuntimes(
	runs: readonly RunEntry[],
): ContainerRuntimeAdapter[] {
	const runtimes = new Map<string, ContainerRuntimeAdapter>();
	for (const { container } of runs.flatMap((run) => run.services)) {
		if (!container) continue;
		const key = containerKey(container);
		if (!runtimes.has(key))
			runtimes.set(
				key,
				getContainerRuntimeAdapter(container.runtime, {
					binary: container.binary,
				}),
			);
	}
	return [...runtimes.values()];
}

function containerKey(container: { runtime: string; binary?: string }) {
	return `${container.runtime}\0${container.binary ?? ""}`;
}

function containerKeys(run: RunEntry): string[] {
	return run.services.flatMap(({ container }) =>
		container ? [containerKey(container)] : [],
	);
}
