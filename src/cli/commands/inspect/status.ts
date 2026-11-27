import { getErrorMessage, typedSwitch, typedSwitchGroup } from "hanzio";
import {
	containerRuntimeForEnv,
	isRuntimeUp,
} from "../../../container-runtime";
import {
	buncargoContainersOf,
	portOwnersOf,
} from "../../../container-runtime/containers";
import type { ContainerRuntimeAdapter } from "../../../container-runtime/types";
import {
	checkSlotStatus,
	formatCheckSlotHolder,
} from "../../../core/check-slots";
import { readEnvOverrides } from "../../../core/env-overrides";
import { resolveLinksFromRuns } from "../../../core/links";
import { describeStrayLoopbackUrl } from "../../../core/loopback-env";
import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
	withBindProbe,
} from "../../../core/process";
import { describeRemoval, readRemovals } from "../../../core/removal-log";
import { type RunEntry, readLiveRuns } from "../../../core/run-registry";
import { internalsOf } from "../../../environment";
import type {
	AnyDevEnvironment,
	BuncargoContainer,
	LinkInspection,
	PortContainerOwner,
} from "../../../types";
import { BASE_EXITS, defineCommand } from "../../command-spec";
import { strayLoopbackUrls } from "../../core-checks";
import {
	devCommandWith,
	leftOutApps,
	planLateStart,
	runsThatCanStart,
} from "../../dev-late-start";
import type { StartableAppJson, StatusJson } from "../../json-documents";
import * as log from "../../log";
import { loadLiveEnv } from "../load-env";

/**
 * `buncargo status` shows this checkout's containers, ports, hosts, tunnels and
 * runs. `--json` is the same snapshot as one object, so a script or an agent
 * reads it instead of hunting ports out of logs and `docker ps`.
 */
export const statusCommand = defineCommand({
	spec: {
		name: "status",
		summary: "Show this project's containers, ports, and tunnels",
		flags: {
			json: { kind: "boolean", description: "One JSON document on stdout" },
		},
	},
	exits: BASE_EXITS,
	json: "StatusJson (--json)",
	run: async ({ values }) => {
		const status = await readStatus();

		if (values.json) log.line(JSON.stringify(status, null, 2));
		else printStatus(status);

		return 0;
	},
});

async function readStatus(): Promise<StatusJson> {
	// As `env` and `url` see it: named URLs once the daemon serves this
	// checkout's run, rather than a read-only load that never activates them.
	const env = await loadLiveEnv();
	const runtime = containerRuntimeForEnv(env);

	// One listing of the runtime answers both who holds each port and which
	// containers this checkout has, overlapped with the run registry read.
	const [listing, allLiveRuns] = await Promise.all([
		readContainerListing(runtime),
		readLiveRuns().catch(() => []),
	]);
	// `planPortOffset` probes shifted blocks beyond `env.ports` when the offset
	// is still an unprobed hash, so only pass `ports` as exhaustive otherwise.
	// When `readContainerListing` already failed, pass an empty container map so
	// the port snapshot does not spawn the same failing container listing again.
	const envPorts = Object.values(env.ports as Record<string, number>);
	const snapshot = await createPortOwnerSnapshotAsync({
		runtime,
		ports: env.portOffsetProvenance === "hash" ? undefined : envPorts,
		cwdPorts: envPorts,
		containers: "inventory" in listing ? listing.portOwners : new Map(),
	});
	const ownerOf = withBindProbe((port) => snapshot.owner(port));

	const ports = Object.fromEntries(
		Object.entries(env.ports as Record<string, number>).map(([name, port]) => {
			const owner = ownerOf(port);
			const action = classifyPortOccupant(owner, {
				root: env.root,
				projectName: env.projectName,
				runtime: runtime.name,
			});
			return [
				name,
				{
					port,
					state: typedSwitch(action, {
						free: () => "free" as const,
						fail: () => "foreign" as const,
						...typedSwitchGroup(
							action,
							["reuse", "kill"],
							() => "ours" as const,
						),
					}),
					owner: owner ? formatPortOwner(port, owner) : null,
				},
			];
		}),
	);

	const containers:
		{ service: string; name: string; status: string }[] | { error: string } =
		"inventory" in listing
			? listing.inventory
					.filter((item) => item.project === env.projectName)
					.map((item) => ({
						service: item.service || item.name,
						name: item.name,
						status: item.status,
					}))
			: { error: listing.error };

	const runs = allLiveRuns.filter((run) => run.root === env.root);
	const canStart = new Set(runsThatCanStart(runs));

	// The public URLs the live runs publish: each run's tunnels, which close
	// with it, and the URLs its apps printed.
	const publicUrls = new Map(
		runs
			.flatMap((run) => [...run.apps, ...run.services])
			.flatMap((row) =>
				row.publicUrl === undefined ? [] : [[row.name, row.publicUrl] as const],
			),
	);
	const tunnels = [...publicUrls].map(([name, publicUrl]) => ({
		name,
		publicUrl,
	}));

	// Before a run has persisted its block, the offset shown is the unprobed
	// hash: say so when the next run would move it, or an agent tests ports
	// nothing will listen on.
	let plannedOffset: ReturnType<typeof describePlannedOffset>;
	try {
		plannedOffset =
			env.portOffsetProvenance === "hash"
				? describePlannedOffset({
						offset: env.portOffset,
						planned: internalsOf(env).planPortOffset(ownerOf).offset,
						ports,
					})
				: undefined;
	} catch {
		// No free block at all: `dev` takes back an idle one, or names the holders.
		plannedOffset = undefined;
	}

	const { inspections: linkInspections, links: resolvedLinks } =
		resolveLinksFromRuns(env.root, internalsOf(env).linksConfig, allLiveRuns);

	return {
		// First: what an agent reads `status` for, and `| head` keeps the top.
		// The live runs of this checkout, with each app's status, pid and URL,
		// and `degraded` while a service container is down under it.
		runs: runs.map((run) => ({
			...run,
			health: runHealth(run),
			startable: canStart.has(run)
				? startableIn(env, run, {
						// One another run lists is not left out: it runs there.
						elsewhere: new Set(
							runs
								.filter((other) => other !== run)
								.flatMap((other) => other.apps.map((app) => app.name)),
						),
						// With several, `restart` must be told which run starts it.
						pickRun: canStart.size > 1,
					})
				: [],
		})),
		project: env.projectName,
		root: env.root,
		portOffset: env.portOffset,
		portOffsetProvenance: env.portOffsetProvenance,
		plannedOffset,
		composeFile: env.composeFile,
		// A runtime that listed its containers is running; an unreachable daemon
		// error already proves it is down without spawning a second probe.
		runtime: {
			name: runtime.name,
			running:
				"inventory" in listing ||
				(!isUnreachableRuntimeError(listing.error) && isRuntimeUp(runtime)),
		},
		checkSlots: checkSlotStatus(process.env),
		ports,
		urls: env.urls,
		containers,
		hosts: env.hosts
			? {
					mode: env.hosts.mode,
					tld: env.hosts.tld,
					active: env.hosts.active,
					plan: env.hosts.plan.map((entry) => ({
						hostname: entry.hostname,
						targetPort: entry.targetPort,
					})),
					// Tailscale mode: each app Tailscale serves, by name.
					tailscaleUrls: env.hosts.tailscaleUrls,
				}
			: null,
		tunnels,
		// Who stopped or removed this checkout's containers lately: the trace
		// for a service that went away with no error.
		recentStops: readRemovals()
			.filter((record) => record.root === env.root)
			.slice(-RECENT_STOPS)
			.map((record) => ({ ...record, description: describeRemoval(record) })),
		// `buncargo env set` keys, applied to every run of this checkout. Names
		// only: one may hide a secret; `env --get KEY` reads a value.
		envOverrides: Object.keys(readEnvOverrides(env.root)),
		links: [...linkInspections],
		strayLoopbackUrls: strayLoopbackUrls(
			env as AnyDevEnvironment,
			resolvedLinks,
		).map((stray) => ({ ...stray, message: describeStrayLoopbackUrl(stray) })),
	} satisfies StatusJson;
}

function isUnreachableRuntimeError(error: string): boolean {
	return /cannot connect|connection refused|is the docker daemon running|no such file|enoent|not running|stopped|failed to connect|unable to connect/i.test(
		error,
	);
}

/**
 * The runtime's buncargo containers and the ports its containers hold, from
 * one listing, or why it could not say.
 */
async function readContainerListing(runtime: ContainerRuntimeAdapter): Promise<
	| {
			inventory: BuncargoContainer[];
			portOwners: Map<number, PortContainerOwner>;
	  }
	| { error: string }
> {
	try {
		const listed = await runtime.containers();
		return {
			inventory: buncargoContainersOf(listed, runtime.name),
			portOwners: portOwnersOf(listed, runtime.name),
		};
	} catch (error) {
		return { error: getErrorMessage(error) };
	}
}

/**
 * The apps `run` (one of {@link runsThatCanStart}) left out and can start,
 * leaving out those `elsewhere` runs: each with what it brings, the services
 * it lacks, and the command that starts it.
 */
export function startableIn(
	config: Pick<AnyDevEnvironment, "apps" | "services">,
	run: Pick<RunEntry, "apps" | "services" | "sessionId">,
	options: { elsewhere: ReadonlySet<string>; pickRun: boolean },
): StartableAppJson[] {
	const running = new Set(run.apps.map((app) => app.name));
	const services = new Set(run.services.map((service) => service.name));
	const runFlag = options.pickRun ? ` --run=${run.sessionId}` : "";
	const leftOut = leftOutApps(config.apps, running).filter(
		(name) => !options.elsewhere.has(name),
	);
	return leftOut.map((name) => {
		const plan = planLateStart(config, { running, services }, name);
		return {
			name,
			apps: Object.keys(plan.apps),
			missingServices: plan.missingServices,
			command:
				plan.missingServices.length === 0
					? `buncargo restart ${name}${runFlag}`
					: devCommandWith(running, name),
		};
	});
}

/** How many of this checkout's removal records `status` shows. */
const RECENT_STOPS = 5;

/** `degraded` while any service of the run has a problem its watch recorded. */
export function runHealth(run: Pick<RunEntry, "services">): "ok" | "degraded" {
	return run.services.some((service) => service.problem) ? "degraded" : "ok";
}

/**
 * Where the next `dev` will move an unclaimed block, and why, or undefined
 * when it keeps this one. The reason is the first port of this block another
 * process holds.
 */
export function describePlannedOffset(input: {
	offset: number;
	planned: number;
	ports: Record<string, { port: number; state: string; owner: string | null }>;
}): { offset: number; reason: string } | undefined {
	if (input.planned === input.offset) return undefined;
	const taken = Object.entries(input.ports).find(
		([, port]) => port.state === "foreign",
	);
	const reason = taken
		? `${taken[0]}: ${taken[1].owner ?? `port ${taken[1].port} is in use`}`
		: "another checkout claims this block";
	return { offset: input.planned, reason };
}

/**
 * One line per app of this checkout's live runs, `name  status  url`, aligned:
 * the first thing `status` prints, so `| head` shows it. Then each app a run
 * left out, `off`, with the command that starts it.
 */
export function appStatusLines(
	runs: readonly (Pick<RunEntry, "apps"> & {
		startable: readonly StartableAppJson[];
	})[],
): string[] {
	const listed = runs.flatMap((run) => run.apps);
	if (listed.length === 0) {
		return ["apps: no live run (start one with `buncargo dev --detach`)"];
	}

	const off = new Map<string, StartableAppJson>();
	for (const app of runs.flatMap((run) => run.startable)) {
		const existing = off.get(app.name);
		if (
			!existing ||
			(existing.missingServices.length > 0 && app.missingServices.length === 0)
		) {
			off.set(app.name, app);
		}
	}
	const apps = [
		...listed,
		...[...off.values()].map((app) => ({
			name: app.name,
			status: "off",
			openUrl:
				app.missingServices.length === 0
					? app.command
					: `needs ${app.missingServices.join(", ")}: ${app.command}`,
		})),
	];

	const nameWidth = Math.max(...apps.map((app) => app.name.length));
	const statusWidth = Math.max(...apps.map((app) => app.status.length));
	return [
		"apps:",
		...apps.map((app) => {
			const name = app.name.padEnd(nameWidth);
			const status = app.status.padEnd(statusWidth);
			return `  ${name}  ${status}  ${app.openUrl ?? ""}`.trimEnd();
		}),
	];
}

function formatStatusLink(item: LinkInspection): string {
	return typedSwitch(item.status, {
		linked: () =>
			item.link
				? `${item.link.projectName} (${item.source}) ${item.link.root}`
				: `linked (${item.source})`,
		"missing-endpoints": () => {
			const missing = [...item.missingApps, ...item.missingServices].join(", ");
			const target = item.link
				? `${item.link.projectName} (${item.source}) ${item.link.root}`
				: item.project;
			return `${target} (missing: ${missing})`;
		},
		ambiguous: () =>
			`ambiguous (${item.candidates.length} running, run \`buncargo links pin ${item.name} <path>\`)`,
		disabled: () => "disabled (profile)",
		"not-running": () => {
			if (item.pinProjectMismatch && item.pinnedRoot) {
				return `wrong project at ${item.pinnedRoot} (running "${item.pinProjectMismatch}", expected "${item.project}")`;
			}
			if (item.pinMissing && item.pinnedRoot) {
				return `not-running (pinned path missing: ${item.pinnedRoot})`;
			}
			return item.source === "pinned" ? "not-running (pinned)" : "not-running";
		},
	});
}

function printStatus(status: StatusJson): void {
	for (const line of appStatusLines(status.runs)) log.line(line);

	log.line();
	log.line(`project: ${status.project}`);
	log.line(`root: ${status.root}`);
	log.line(`portOffset: ${status.portOffset} (${status.portOffsetProvenance})`);
	if (status.plannedOffset) {
		log.warn(
			`The next \`buncargo dev\` moves this checkout to offset ${status.plannedOffset.offset} (${status.plannedOffset.reason}), so the ports below change by ${status.plannedOffset.offset - status.portOffset}. Start the run before testing against them.`,
		);
	}
	log.line(`composeFile: ${status.composeFile}`);
	log.line(
		`runtime: ${status.runtime.name} (${status.runtime.running ? "running" : "not running"})`,
	);
	log.line();
	log.line("ports:");
	for (const [name, { port, owner }] of Object.entries(status.ports)) {
		log.line(`  ${name}: ${port}  ${owner ?? "free"}`);
	}

	log.line();
	log.line("containers:");
	if ("error" in status.containers) {
		log.line(`  (${status.containers.error})`);
	} else if (status.containers.length === 0) {
		log.line("  (none)");
	} else {
		for (const item of status.containers) {
			log.line(`  ${item.service}: ${item.status}`);
		}
	}

	if (status.hosts) {
		log.line();
		log.line("hosts:");
		log.line(`  mode: ${status.hosts.mode}`);
		log.line(`  active: ${status.hosts.active ? "yes" : "no"}`);
		if (status.hosts.mode === "tailscale") {
			for (const [app, url] of Object.entries(status.hosts.tailscaleUrls)) {
				log.line(`  ${app}: ${url} → :${status.ports[app].port}`);
			}
		} else {
			log.line(`  tld: ${status.hosts.tld}`);
			for (const entry of status.hosts.plan) {
				log.line(`  ${entry.hostname} → :${entry.targetPort}`);
			}
		}
	}

	if (status.tunnels.length > 0) {
		log.line();
		log.line("tunnels:");
		for (const entry of status.tunnels) {
			log.line(`  ${entry.name}: ${entry.publicUrl}`);
		}
	}

	if (status.envOverrides.length > 0) {
		log.line();
		log.line(
			`env overrides (buncargo env set): ${status.envOverrides.join(", ")}`,
		);
	}

	if (status.links.length > 0) {
		log.line();
		log.line("links:");
		for (const item of status.links) {
			log.line(`  ${item.name}: ${formatStatusLink(item)}`);
		}
	}

	const slots = status.checkSlots;
	if (slots.enabled && (slots.holders.length > 0 || slots.waiting > 0)) {
		log.line();
		log.line(
			`check slots: ${slots.holders.length} of ${slots.capacity} taken, ${slots.waiting} waiting (this user's, in ${slots.dir})`,
		);
		for (const holder of slots.holders) {
			log.line(`  ${formatCheckSlotHolder(holder)}`);
		}
	}

	for (const stray of status.strayLoopbackUrls) log.warn(stray.message);

	for (const run of status.runs) {
		log.line();

		const health = run.health === "degraded" ? " (degraded)" : "";
		const profile = run.profile ? ` [profile: ${run.profile}]` : "";
		// Its apps are at the top.
		log.line(
			`run ${run.sessionId}${profile}${health}: ${run.apps.length} apps`,
		);
		for (const service of run.services) {
			if (service.problem) {
				log.line(`  ${service.name}: ${service.problem.detail}`);
			}
		}
	}

	if (status.recentStops.length > 0) {
		log.line();
		log.line("recent stops and removals:");
		for (const record of status.recentStops) {
			log.line(`  ${record.description}`);
		}
	}
}
