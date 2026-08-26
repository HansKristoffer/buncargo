import {
	isHostsDaemonHealthy,
	loadHostRoutes,
	pruneHostRoutes,
	readDaemonConfig,
	runHostsDaemon,
	runHostsInstall,
	runHostsUninstall,
	syncHostsFile,
} from "../../core/hosts";
import {
	getCaPath,
	isCaPresent,
	resolvedMkcertPath,
} from "../../core/hosts/mkcert";
import {
	describeStaleHostsService,
	isHostsServiceInstalled,
	readHostsServiceManifest,
} from "../../core/hosts/service";
import { describePortSquatter } from "../../core/hosts/squatter";
import * as log from "../log";
import { hostsSubcommandList, resolveHostsSubcommand } from "./registry";

export async function handleHosts(args: string[]): Promise<void> {
	const requested = args[0] ?? "status";
	const subcommand = resolveHostsSubcommand(requested);
	if (!subcommand) {
		log.fail(`Unknown hosts command: ${requested}`, [
			`Use: buncargo hosts ${hostsSubcommandList()}`,
		]);
	}

	switch (subcommand) {
		case "install":
			// Always reload the service: this is the command users are told to run
			// when named hosts are broken, so it has to replace a stale daemon.
			await runHostsInstall({ reinstallService: true });
			log.done("Named hosts are ready");
			return;
		case "uninstall":
			await runHostsUninstall();
			log.done("Named hosts were removed from this machine");
			return;
		case "status":
			await printHostsStatus();
			return;
		case "sync": {
			const routes = await pruneHostRoutes();
			syncHostsFile(routes.map((route) => route.hostname));
			log.done(
				`Synced ${routes.length} hostname${routes.length === 1 ? "" : "s"} to /etc/hosts`,
			);
			return;
		}
		case "prune": {
			const before = (await loadHostRoutes()).length;
			const after = await pruneHostRoutes();
			const removed = before - after.length;
			log.done(`Pruned ${removed} stale route${removed === 1 ? "" : "s"}`);
			return;
		}
		case "daemon":
			await runHostsDaemon({ service: args.includes("--service") });
			return;
		default: {
			const exhaustive: never = subcommand;
			throw new Error(`Unhandled hosts subcommand: ${String(exhaustive)}`);
		}
	}
}

async function printHostsStatus(): Promise<void> {
	const config = readDaemonConfig();
	const healthy = await isHostsDaemonHealthy(config.httpsPort);
	const mkcertPath = resolvedMkcertPath();
	log.line(`daemon: ${healthy ? "healthy" : "down"}`);
	log.line(`httpsPort: ${config.httpsPort}`);
	log.line(`service: ${isHostsServiceInstalled() ? "installed" : "missing"}`);
	const manifest = readHostsServiceManifest();
	if (manifest) {
		log.line(`  exec: ${[manifest.program, ...manifest.args].join(" ")}`);
	}
	log.line(`mkcert: ${mkcertPath ?? "missing"}`);
	const stale = describeStaleHostsService();
	if (stale) {
		log.line(`  stale: ${stale}`);
	}
	log.line(
		`ca: ${isCaPresent(mkcertPath) ? getCaPath(mkcertPath) : "missing"}`,
	);
	if (!healthy) {
		const squatter = describePortSquatter(config.httpsPort);
		if (squatter) {
			log.line(`port: ${squatter}`);
		}
	}
	const routes = await pruneHostRoutes();
	log.line();
	log.line("routes:");
	if (routes.length === 0) {
		log.line("  (none)");
		return;
	}
	for (const route of routes) {
		const owner = route.pid === undefined ? "static" : `pid ${route.pid}`;
		log.line(
			`  ${route.hostname} → :${route.port}  (${route.kind}:${route.name}, ${owner})`,
		);
	}
}
