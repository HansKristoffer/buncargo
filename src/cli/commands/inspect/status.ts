import { existsSync } from "node:fs";
import {
	containerRuntimeForEnv,
	listBuncargoContainers,
} from "../../../container-runtime";
import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
	withBindProbe,
} from "../../../core/process";
import { readLiveRuns } from "../../../core/run-registry";
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
					state:
						action === "free" ? "free" : action === "fail" ? "foreign" : "ours",
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
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const tunnels = existsSync(getTunnelRegistryPath(env.root))
		? (await readLiveTunnelRegistry(env.root)).map((entry) => ({
				name: entry.name,
				publicUrl: entry.publicUrl,
			}))
		: [];

	return {
		project: env.projectName,
		root: env.root,
		portOffset: env.portOffset,
		portOffsetProvenance: env.portOffsetProvenance,
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
		// The live runs of this checkout, with each app's status, pid and URL.
		runs: (await readLiveRuns().catch(() => [])).filter(
			(run) => run.root === env.root,
		),
	};
}

function printStatus(status: Awaited<ReturnType<typeof readStatus>>): void {
	log.line(`project: ${status.project}`);
	log.line(`root: ${status.root}`);
	log.line(`portOffset: ${status.portOffset} (${status.portOffsetProvenance})`);
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
	for (const run of status.runs) {
		log.line();
		log.line(`run ${run.sessionId}:`);
		for (const app of run.apps ?? [])
			log.line(
				`  ${app.name}: ${app.status}${app.openUrl ? `  ${app.openUrl}` : ""}`,
			);
	}
}
