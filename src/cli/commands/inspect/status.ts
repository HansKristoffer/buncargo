import { existsSync } from "node:fs";
import { getErrorMessage, typedSwitch, typedSwitchGroup } from "hanzio";
import {
	containerRuntimeForEnv,
	listBuncargoContainers,
} from "../../../container-runtime";
import { readEnvOverrides } from "../../../core/env-overrides";
import { describeStrayLoopbackUrl } from "../../../core/loopback-env";
import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
	withBindProbe,
} from "../../../core/process";
import { describeRemoval, readRemovals } from "../../../core/removal-log";
import { type RunEntry, readLiveRuns } from "../../../core/run-registry";
import type { AnyDevEnvironment } from "../../../types";
import { strayLoopbackUrls } from "../../core-checks";
import { hasFlag } from "../../flags";
import * as log from "../../log";
import {
	getTunnelRegistryPath,
	readLiveTunnelRegistry,
} from "../../tunnel-registry";
import { loadLiveEnv } from "../runtime";

/**
 * `buncargo status` — this checkout's containers, ports, hosts, tunnels and
 * runs. `--json` is the same snapshot as one object, so a script or an agent
 * reads it instead of hunting ports out of logs and `docker ps`.
 */
export async function handleStatus(args: string[] = []): Promise<void> {
	const status = await readStatus();
	if (hasFlag(args, "--json")) {
		log.line(JSON.stringify(status, null, 2));
		return;
	}
	printStatus(status);
}

async function readStatus() {
	// As `env` and `url` see it: named URLs once the daemon serves this
	// checkout's run, rather than a read-only load that never activates them.
	const env = await loadLiveEnv();
	const runtime = containerRuntimeForEnv(env);
	const ownerOf = withBindProbe((port) => getPortOwner(port, { runtime }));

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
						free: () => "free",
						fail: () => "foreign",
						...typedSwitchGroup(action, ["reuse", "kill"], () => "ours"),
					}),
					owner: owner ? formatPortOwner(port, owner) : null,
				},
			];
		}),
	);

	let containers:
		| { service: string; name: string; status: string }[]
		| { error: string };
	try {
		containers = listBuncargoContainers([runtime])
			.filter((item) => item.project === env.projectName)
			.map((item) => ({
				service: item.service || item.name,
				name: item.name,
				status: item.status,
			}));
	} catch (error) {
		containers = {
			error: getErrorMessage(error),
		};
	}

	const tunnels = existsSync(getTunnelRegistryPath(env.root))
		? (await readLiveTunnelRegistry(env.root)).map((entry) => ({
				name: entry.name,
				publicUrl: entry.publicUrl,
			}))
		: [];

	// Before a run has persisted its block, the offset shown is the unprobed
	// hash: say so when the next run would move it, or an agent tests ports
	// nothing will listen on.
	let plannedOffset: ReturnType<typeof describePlannedOffset>;
	try {
		plannedOffset =
			env.portOffsetProvenance === "hash"
				? describePlannedOffset({
						offset: env.portOffset,
						planned: env.planPortOffset().offset,
						ports,
					})
				: undefined;
	} catch {
		// No free block at all: `dev` refuses with the fix.
		plannedOffset = undefined;
	}

	return {
		project: env.projectName,
		root: env.root,
		portOffset: env.portOffset,
		portOffsetProvenance: env.portOffsetProvenance,
		plannedOffset,
		composeFile: env.composeFile,
		runtime: { name: runtime.name, running: runtime.isAvailable() },
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
		// The live runs of this checkout, with each app's status, pid and URL,
		// and `degraded` while a service container is down under it.
		runs: (await readLiveRuns().catch(() => []))
			.filter((run) => run.root === env.root)
			.map((run) => ({ ...run, health: runHealth(run) })),
		// Who stopped or removed this checkout's containers lately: the trace
		// for a service that went away with no error.
		recentStops: readRemovals()
			.filter((record) => record.root === env.root)
			.slice(-RECENT_STOPS)
			.map((record) => ({ ...record, description: describeRemoval(record) })),
		// `buncargo env set` keys, applied to every run of this checkout. Names
		// only: one may hide a secret; `env --get KEY` reads a value.
		envOverrides: Object.keys(readEnvOverrides(env.root)),
		strayLoopbackUrls: strayLoopbackUrls(env as AnyDevEnvironment).map(
			(stray) => ({ ...stray, message: describeStrayLoopbackUrl(stray) }),
		),
	};
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

function printStatus(status: Awaited<ReturnType<typeof readStatus>>): void {
	log.line(`project: ${status.project}`);
	log.line(`root: ${status.root}`);
	log.line(`portOffset: ${status.portOffset} (${status.portOffsetProvenance})`);
	if (status.plannedOffset)
		log.warn(
			`The next \`buncargo dev\` moves this checkout to offset ${status.plannedOffset.offset} (${status.plannedOffset.reason}), so the ports below change by ${status.plannedOffset.offset - status.portOffset}. Start the run before testing against them.`,
		);
	log.line(`composeFile: ${status.composeFile}`);
	log.line(
		`runtime: ${status.runtime.name} (${status.runtime.running ? "running" : "not running"})`,
	);
	log.line();
	log.line("ports:");
	for (const [name, { port, owner }] of Object.entries(status.ports))
		log.line(`  ${name}: ${port}  ${owner ?? "free"}`);
	log.line();
	log.line("containers:");
	if ("error" in status.containers) log.line(`  (${status.containers.error})`);
	else if (status.containers.length === 0) log.line("  (none)");
	else
		for (const item of status.containers)
			log.line(`  ${item.service}: ${item.status}`);
	if (status.hosts) {
		log.line();
		log.line("hosts:");
		log.line(`  mode: ${status.hosts.mode}`);
		log.line(`  active: ${status.hosts.active ? "yes" : "no"}`);
		if (status.hosts.mode === "tailscale") {
			for (const [app, url] of Object.entries(status.hosts.tailscaleUrls))
				log.line(`  ${app}: ${url} → :${status.ports[app].port}`);
		} else {
			log.line(`  tld: ${status.hosts.tld}`);
			for (const entry of status.hosts.plan)
				log.line(`  ${entry.hostname} → :${entry.targetPort}`);
		}
	}
	if (existsSync(getTunnelRegistryPath(status.root))) {
		log.line();
		log.line("tunnels:");
		if (status.tunnels.length === 0) log.line("  (none)");
		else
			for (const entry of status.tunnels)
				log.line(`  ${entry.name}: ${entry.publicUrl}`);
	}
	if (status.envOverrides.length > 0) {
		log.line();
		log.line(
			`env overrides (buncargo env set): ${status.envOverrides.join(", ")}`,
		);
	}
	for (const stray of status.strayLoopbackUrls) log.warn(stray.message);
	for (const run of status.runs) {
		log.line();
		const health = run.health === "degraded" ? " (degraded)" : "";
		log.line(`run ${run.sessionId}${health}:`);
		for (const app of run.apps ?? [])
			log.line(
				`  ${app.name}: ${app.status}${app.openUrl ? `  ${app.openUrl}` : ""}`,
			);
		for (const service of run.services)
			if (service.problem)
				log.line(`  ${service.name}: ${service.problem.detail}`);
	}
	if (status.recentStops.length > 0) {
		log.line();
		log.line("recent stops and removals:");
		for (const record of status.recentStops)
			log.line(`  ${record.description}`);
	}
}
