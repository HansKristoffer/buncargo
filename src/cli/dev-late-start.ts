import { getErrorMessage, mapValues } from "hanzio";
import { describeLeaseRefusal } from "../core/app-leases";
import { startableApps } from "../core/process/dev-servers";
import type { RunOutput, StartReply } from "../core/process/run-output";
import type { RunEntry } from "../core/run-registry";
import { formatStep, formatWarn } from "../core/style";
import type { LeasePolicy } from "../environment/app-leases";
import type { LateStart } from "../environment/pipeline";
import { planStart } from "../planning";
import type { ResolvedApp, ResolvedService } from "../types";
import { leaseTakeoverHints } from "./dev-leases";

/**
 * Starting an app a running `dev` left out (not in `--apps` or the profile):
 * the TUI's `r` on one, and `buncargo restart <app>`. It joins the run's
 * session as an `essential: false` app, since the run went on without it, so
 * its going down never ends the run. Its `requiredApps` the run has not
 * started come with it. Only on the run's own services: an app that needs a
 * service the run did not start is refused, because adding containers to a
 * running stack is a new start.
 */

/** The apps a run left out that it can start later: every one with a dev command. */
export function leftOutApps(
	apps: Readonly<Record<string, ResolvedApp>>,
	inRun: ReadonlySet<string>,
): string[] {
	return Object.keys(startableApps({ ...apps }, false)).filter(
		(name) => !inRun.has(name),
	);
}

/** What starting a left-out app in a run takes. */
export interface LateStartPlan {
	/** It and the `requiredApps` the run has not started, in start order. */
	apps: Record<string, ResolvedApp>;
	/** Services it needs that the run did not start: none, or it cannot start there. */
	missingServices: string[];
}

/**
 * Plan starting `name` in a run of `running` apps on `runServices`: what the
 * run does on `r`, and what `status` lists as startable.
 */
export function planLateStart(
	config: {
		apps: Readonly<Record<string, ResolvedApp>>;
		services: Readonly<Record<string, ResolvedService>>;
	},
	run: { running: ReadonlySet<string>; services: ReadonlySet<string> },
	name: string,
): LateStartPlan {
	const plan = planStart(config.apps, config.services, { onlyApps: [name] });
	return {
		apps: Object.fromEntries(
			Object.entries(startableApps(plan.apps, false)).filter(
				([other]) => !run.running.has(other),
			),
		),
		missingServices: plan.requiredServiceKeys.filter(
			(service) => !run.services.has(service),
		),
	};
}

/** The `dev` that starts a new run with these apps: one that needs services this run did not start. */
export function devCommandWith(
	running: Iterable<string>,
	name: string,
): string {
	return `buncargo dev --apps=${[...running, name].join(",")}`;
}

/**
 * The runs of a checkout that can start an app they left out: those that
 * spawned apps, since a `dev` reads requests from before its first spawn.
 * `status` lists what they can start and `restart` asks one of them.
 */
export function runsThatCanStart<TRun extends Pick<RunEntry, "apps">>(
	runs: readonly TRun[],
): TRun[] {
	return runs.filter((run) => run.apps.some((app) => app.pid !== undefined));
}

export interface LateStartRun {
	/** Every configured app. */
	apps: Readonly<Record<string, ResolvedApp>>;
	services: Readonly<Record<string, ResolvedService>>;
	/** The services this run started. */
	runServices: ReadonlySet<string>;
	/** The apps this run runs now: started, reused or taken on since. */
	running(): readonly string[];
	/**
	 * Which of these apps already answer on their port outside this run
	 * (another run, another terminal), as startup reuses them; throws when a
	 * port is held by something it cannot reuse. Never stops a process that
	 * serves.
	 */
	servedElsewhere(
		apps: Record<string, ResolvedApp>,
	): Promise<readonly string[]>;
	/** The `preflight` steps these apps bring, without a terminal; throws why not. */
	preflight(names: readonly string[]): Promise<void>;
	start: LateStart;
	leasePolicy: LeasePolicy;
	signal?: AbortSignal;
}

/** Start `name` in a running session. See {@link LateStartRun}. */
export async function startLeftOutApp(
	run: LateStartRun,
	name: string,
): Promise<StartReply> {
	const app = run.apps[name];
	if (!app || app.devCommand === false) {
		return {
			status: "refused",
			reason: `"${name}" is not an app with a dev command`,
		};
	}
	// Taken on by an earlier request: asking again is not an error.
	const running = new Set(run.running());
	if (running.has(name)) return { status: "started", apps: [] };

	const plan = planLateStart(run, { running, services: run.runServices }, name);
	if (plan.missingServices.length > 0) {
		const needs = plan.missingServices.join(", ");
		return {
			status: "refused",
			reason: `${name} needs ${needs}, which this run did not start. End the run and start it with them: ${devCommandWith(running, name)}`,
		};
	}

	// Its own port answering elsewhere: starting it here would kill that one.
	// A required app served elsewhere is used there, as at startup.
	let elsewhere: readonly string[];
	try {
		elsewhere = await run.servedElsewhere(plan.apps);
	} catch (error) {
		return { status: "refused", reason: getErrorMessage(error) };
	}
	if (elsewhere.includes(name)) {
		return {
			status: "refused",
			reason: `${name} already runs outside this run, on its port. Use it there, or stop it (buncargo stop ${name}) and start it again here.`,
		};
	}

	// Spared like any `essential: false` app, its lease included: one held
	// elsewhere is a refusal here, never a prompt over the TUI.
	const toStart = mapValues(
		Object.fromEntries(
			Object.entries(plan.apps).filter(([other]) => !elsewhere.includes(other)),
		),
		(config) => ({ ...config, essential: false }),
	);
	try {
		await run.preflight(Object.keys(toStart));
	} catch (error) {
		return { status: "refused", reason: getErrorMessage(error) };
	}

	const outcome = await run.start(toStart, {
		leasePolicy: run.leasePolicy,
		signal: run.signal,
	});
	if (outcome.status === "refused") {
		const { skipped } = outcome;
		return {
			status: "refused",
			reason: [
				`${skipped.app} cannot start: ${skipped.key} is in use by another run.`,
				...describeLeaseRefusal(skipped),
				...leaseTakeoverHints(skipped),
			].join("\n"),
		};
	}

	return { status: "started", apps: outcome.apps };
}

/**
 * The apps the run left out, each with the services it lacks, and how to
 * start one; undefined when it left none out.
 */
export function leftOutNotice(
	run: Pick<LateStartRun, "apps" | "services" | "runServices" | "running">,
): string | undefined {
	const running = new Set(run.running());
	const names = leftOutApps(run.apps, running).map((name) => {
		const { missingServices } = planLateStart(
			run,
			{ running, services: run.runServices },
			name,
		);
		return missingServices.length === 0
			? name
			: `${name} (needs ${missingServices.join(", ")})`;
	});
	if (names.length === 0) return undefined;

	return `Not started: ${names.join(", ")}. Start one in this run with r on it, or \`buncargo restart <app>\`.`;
}

/**
 * Bind `output.startApp` to start left-out apps in this run, one request at
 * a time: a second `r` while the first is still claiming then finds the app
 * part of the run instead of claiming it again. Each answer is said in the
 * run's output too (a refusal in full, which the TUI's footer cuts to a line).
 */
export function bindLateStarts(output: RunOutput, run: LateStartRun): void {
	let queue: Promise<unknown> = Promise.resolve();

	// Once, in the Overview, stream mode and the log: what more it can run.
	const notice = leftOutNotice(run);
	if (notice) output.announce("buncargo", notice, { raw: formatStep(notice) });

	const startOne = async (name: string): Promise<StartReply> => {
		try {
			const reply = await startLeftOutApp(run, name);
			if (reply.status === "refused") {
				for (const line of reply.reason.split("\n")) {
					output.event(name, line, "warn");
				}
			} else if (reply.apps.length > 0) {
				const text = `Starting ${reply.apps.join(", ")}, which this run left out`;
				output.announce("buncargo", text, { raw: formatStep(text) });
			}
			return reply;
		} catch (error) {
			const text = `${name} could not start: ${getErrorMessage(error)}`;
			output.announce(name, text, { raw: formatWarn(text), level: "error" });
			throw error;
		}
	};

	output.startApp = (name) => {
		const reply = queue.then(() => startOne(name));
		queue = reply.catch(() => {});
		return reply;
	};
}
