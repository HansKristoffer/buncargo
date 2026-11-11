import { typedSwitch } from "hanzio";
import {
	describeLoopbackHijack,
	identityRouteOwners,
	loadHostRoutes,
	OUTDATED_DAEMON_MESSAGE,
	pruneHostRoutes,
	RELOAD_STALL_MS,
	readHostsDaemonHealth,
	runHostsDaemon,
	runHostsInstall,
	runHostsUninstall,
	syncHostsFile,
} from "../../core/hosts";
import {
	getCaPath,
	isCaTrusted,
	resolvedMkcertPath,
} from "../../core/hosts/mkcert";
import { HOSTS_HTTPS_PORT } from "../../core/hosts/protocol";
import {
	describeStaleHostsService,
	isHostsServiceInstalled,
	readHostsServiceManifest,
} from "../../core/hosts/service";
import { describePortSquatter } from "../../core/hosts/squatter";
import {
	describeTailscaleServeEntries,
	sweepTailscaleServe,
	tailscaleServeDeps,
} from "../../core/hosts/tailscale-serve";
import { hostsMode } from "../../core/runtime-flags";
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

	await typedSwitch(subcommand, {
		install: async () => {
			// Always reload the service: this is the command users are told to run
			// when named hosts are broken, so it has to replace a stale daemon.
			// Never a newer one without --force: another project installed it.
			const notes = await runHostsInstall({
				reinstallService: true,
				force: args.includes("--force"),
			});
			for (const note of notes) log.warn(note);
			log.done("Named hosts are ready");
		},
		uninstall: async () => {
			const warnings = await runHostsUninstall();
			for (const warning of warnings) log.warn(warning);
			log.done("Named hosts were removed from this machine");
		},
		status: () => printHostsStatus(),
		sync: async () => {
			const routes = await pruneHostRoutes();
			syncHostsFile(routes.map((route) => route.hostname));
			log.done(
				`Synced ${routes.length} hostname${routes.length === 1 ? "" : "s"} to /etc/hosts`,
			);
		},
		prune: async () => {
			const before = (await loadHostRoutes()).length;
			// By identity: this is what retires a route whose pid a reboot
			// handed to another process.
			const after = await pruneHostRoutes(undefined, {
				owners: identityRouteOwners,
			});
			const removed = before - after.length;
			log.done(`Pruned ${removed} stale route${removed === 1 ? "" : "s"}`);
			const serve = await sweepTailscaleServe(tailscaleServeDeps());
			for (const line of serve.removed) log.done(line);
			for (const line of serve.failures) log.warn(line);
		},
		daemon: () => runHostsDaemon({ service: args.includes("--service") }),
	});
}

async function printHostsStatus(): Promise<void> {
	const mode = hostsMode();
	log.line(`mode: ${mode}`);
	if (mode === "tailscale") {
		await printTailscaleStatus();
		return;
	}
	const health = await readHostsDaemonHealth();
	const healthy = health !== undefined;
	const mkcertPath = resolvedMkcertPath();
	log.line(
		`daemon: ${!health ? "down" : health.outdated ? "outdated" : "healthy"}`,
	);
	if (health?.outdated) {
		log.line(`  ${OUTDATED_DAEMON_MESSAGE}`);
	} else if (health) {
		log.line(`  protocol: ${health.protocol}`);
		const ageMs = Date.now() - health.lastReloadAt;
		const stale = ageMs > RELOAD_STALL_MS ? "  (stale)" : "";
		log.line(`  refreshed: ${Math.round(ageMs / 1000)}s ago${stale}`);
		// Routes the previous leaf misses show below as not served; this is why.
		if (health.bindError)
			log.line(`  certificate: cannot load the new one (${health.bindError})`);
	}
	log.line(`service: ${isHostsServiceInstalled() ? "installed" : "missing"}`);
	const manifest = readHostsServiceManifest();
	if (manifest) {
		log.line(
			`  buncargo: ${manifest.buncargoVersion} (protocol ${manifest.protocol})`,
		);
		log.line(`  exec: ${[manifest.program, ...manifest.args].join(" ")}`);
	}
	log.line(`mkcert: ${mkcertPath ?? "missing"}`);
	const stale = describeStaleHostsService();
	if (stale) {
		log.line(`  stale: ${stale}`);
	}
	const caPath = getCaPath(mkcertPath);
	const ca = !caPath
		? "missing"
		: isCaTrusted(mkcertPath)
			? caPath
			: `${caPath} (not trusted)`;
	log.line(`ca: ${ca}`);
	if (!healthy) {
		const squatter = describePortSquatter(HOSTS_HTTPS_PORT);
		if (squatter) {
			log.line(`port: ${squatter}`);
		}
	} else {
		const hijack = await describeLoopbackHijack();
		if (hijack) {
			log.line(`port: ${hijack}`);
		}
	}
	const routes = await pruneHostRoutes();
	log.line();
	log.line("routes:");
	if (routes.length === 0) {
		log.line("  (none)");
		return;
	}
	// Marked per route rather than summarized: the registry and the daemon
	// disagreeing is invisible from either side alone, and it is the difference
	// between a working named URL and a 404 from our own proxy.
	const served =
		health && !health.outdated ? new Set(health.hostnames) : undefined;
	for (const route of routes) {
		const owner = route.kind === "app" ? `pid ${route.pid}` : "static";
		const unserved =
			served && !served.has(route.hostname)
				? "  ← not served by the daemon"
				: "";
		log.line(
			`  ${route.hostname} → :${route.port}  (${route.kind}:${route.name}, ${owner})${unserved}`,
		);
	}
}

/** Tailscale mode: every serve entry buncargo recorded, and whether Tailscale still has it. */
async function printTailscaleStatus(): Promise<void> {
	const entries = await describeTailscaleServeEntries(tailscaleServeDeps());
	log.line();
	log.line("tailscale serve:");
	if (entries.length === 0) log.line("  (none)");
	for (const entry of entries) log.line(`  ${entry}`);
}
