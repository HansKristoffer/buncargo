import { existsSync } from "node:fs";
import {
	containerRuntimeForEnv,
	listBuncargoContainers,
} from "../../../container-runtime";
import { formatPortOwner, getPortOwner } from "../../../core/process";
import { loadDevEnv } from "../../../loader";
import * as log from "../../log";
import {
	getTunnelRegistryPath,
	pruneTunnelRegistry,
} from "../../tunnel-registry";

export async function handleStatus(): Promise<void> {
	const env = await loadDevEnv();
	const runtime = containerRuntimeForEnv(env);
	log.line(`project: ${env.projectName}`);
	log.line(`root: ${env.root}`);
	log.line(`portOffset: ${env.portOffset} (${env.portOffsetProvenance})`);
	log.line(`composeFile: ${env.composeFile}`);
	log.line(
		`runtime: ${runtime.name} (${runtime.isAvailable() ? "running" : "not running"})`,
	);
	log.line();
	log.line("ports:");
	for (const [name, port] of Object.entries(env.ports)) {
		const owner = getPortOwner(port, { runtime });
		log.line(
			`  ${name}: ${port}  ${owner ? formatPortOwner(port, owner) : "free"}`,
		);
	}
	log.line();
	log.line("containers:");
	try {
		const containers = listBuncargoContainers([runtime]).filter(
			(item) => item.project === env.projectName,
		);
		if (containers.length === 0) {
			log.line("  (none)");
		} else {
			for (const item of containers) {
				log.line(`  ${item.service || item.name}: ${item.status}`);
			}
		}
	} catch (error) {
		log.line(`  (${error instanceof Error ? error.message : String(error)})`);
	}
	if (env.hosts) {
		log.line();
		log.line("hosts:");
		log.line(`  tld: ${env.hosts.tld}`);
		log.line(`  active: ${env.hosts.active ? "yes" : "no"}`);
		for (const entry of env.hosts.plan) {
			log.line(`  ${entry.hostname} → :${entry.targetPort}`);
		}
	}
	if (existsSync(getTunnelRegistryPath(env.root))) {
		const pruned = await pruneTunnelRegistry(env.root);
		log.line();
		log.line("tunnels:");
		if (pruned.length === 0) {
			log.line("  (none)");
		} else {
			for (const entry of pruned) {
				log.line(`  ${entry.name}: ${entry.publicUrl}`);
			}
		}
	}
}
