import { existsSync } from "node:fs";
import {
	doctorFixHosts,
	isHostsDaemonHealthy,
	pruneHostRoutes,
	readDaemonConfig,
} from "../../../core/hosts";
import { isCaPresent } from "../../../core/hosts/mkcert";
import { describeStaleHostsService } from "../../../core/hosts/service";
import {
	getPortsLockfilePath,
	readPortsLockfile,
} from "../../../core/port-allocation";
import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
} from "../../../core/process";
import { isDockerDaemonRunning } from "../../../docker";
import { loadDevEnv } from "../../../loader";
import { hasFlag } from "../../flags";
import * as log from "../../log";
import {
	getTunnelRegistryPath,
	pruneTunnelRegistry,
} from "../../tunnel-registry";
import { listBuncargoContainers } from "./containers";

type DevEnv = Awaited<ReturnType<typeof loadDevEnv>>;

/** Collects the doctor report so each check stays a small pure-ish function. */
class DoctorReport {
	readonly issues: string[] = [];
	readonly notes: string[] = [];

	issue(message: string): void {
		this.issues.push(message);
	}

	note(message: string): void {
		this.notes.push(message);
	}

	fromError(error: unknown): void {
		this.issue(error instanceof Error ? error.message : String(error));
	}

	print(): void {
		log.line("buncargo doctor");
		log.line();
		for (const note of this.notes) {
			log.line(`  ✓ ${note}`);
		}
		for (const issue of this.issues) {
			log.line(`  ✗ ${issue}`);
		}
		if (this.issues.length === 0) {
			log.line();
			log.line("No issues found.");
		}
	}
}

function checkPortOwnership(report: DoctorReport, env: DevEnv): void {
	for (const [name, port] of Object.entries(env.ports)) {
		const owner = getPortOwner(port);
		if (!owner) continue;
		const action = classifyPortOccupant(owner, {
			root: env.root,
			projectName: env.projectName,
		});
		if (action === "fail") {
			report.issue(formatPortOwner(port, owner));
		} else if (action === "kill") {
			report.note(`Port ${port} (${name}) is held by an orphan from this repo`);
		}
	}
}

function checkPortsLockfile(report: DoctorReport, env: DevEnv): void {
	const lockfile = readPortsLockfile(env.root);
	if (!lockfile) return;
	if (lockfile.projectName !== env.projectName || lockfile.root !== env.root) {
		report.issue(
			`Stale ${getPortsLockfilePath(env.root)} (project/root mismatch). Delete it or run buncargo dev to rewrite it.`,
		);
		return;
	}
	report.note(`ports.json offset ${lockfile.offset} looks consistent`);
}

function checkForeignContainers(report: DoctorReport, env: DevEnv): void {
	if (!isDockerDaemonRunning()) return;
	try {
		const orphans = listBuncargoContainers().filter(
			(item) =>
				item.project === env.projectName && item.root && item.root !== env.root,
		);
		if (orphans.length > 0) {
			report.issue(
				`${orphans.length} container${orphans.length === 1 ? "" : "s"} labeled ${env.projectName} belong to another root`,
			);
		}
	} catch (error) {
		report.fromError(error);
	}
}

async function checkTunnelRegistry(
	report: DoctorReport,
	env: DevEnv,
): Promise<void> {
	if (!existsSync(getTunnelRegistryPath(env.root))) return;
	const after = await pruneTunnelRegistry(env.root);
	report.note(
		after.length === 0
			? "Tunnel registry is empty after prune"
			: `Tunnel registry has ${after.length} live ${after.length === 1 ? "entry" : "entries"}`,
	);
}

async function checkNamedHosts(
	report: DoctorReport,
	env: DevEnv,
): Promise<void> {
	if (!env.hosts) return;
	if (await isHostsDaemonHealthy(readDaemonConfig().httpsPort)) {
		report.note("Named-hosts daemon is healthy");
	} else {
		report.issue(
			"Named-hosts daemon is not running. Run `buncargo hosts install` or `buncargo doctor --fix`.",
		);
	}
	if (!isCaPresent()) {
		report.issue(
			"Named-hosts CA is not trusted. Run `buncargo hosts install`.",
		);
	}
	const staleService = describeStaleHostsService();
	if (staleService) {
		report.issue(staleService);
	}
	const hostRoutes = await pruneHostRoutes();
	report.note(
		hostRoutes.length === 0
			? "Named-hosts route registry is empty after prune"
			: `Named-hosts registry has ${hostRoutes.length} live ${hostRoutes.length === 1 ? "route" : "routes"}`,
	);
}

export async function handleDoctor(args: string[] = []): Promise<void> {
	const report = new DoctorReport();

	if (isDockerDaemonRunning()) {
		report.note("Docker daemon is reachable");
	} else {
		report.issue(
			"Docker is not running. Start Docker Desktop, OrbStack, or Colima.",
		);
	}

	let env: DevEnv | undefined;
	try {
		env = await loadDevEnv();
	} catch (error) {
		report.issue(
			`Could not load dev config: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (env) {
		report.note(
			`Port offset ${env.portOffset} from ${env.portOffsetProvenance}`,
		);
		checkPortOwnership(report, env);
		checkPortsLockfile(report, env);
		checkForeignContainers(report, env);
		await checkTunnelRegistry(report, env);
		await checkNamedHosts(report, env);
	}

	if (hasFlag(args, "--fix")) {
		for (const fixed of await doctorFixHosts()) {
			report.note(fixed);
		}
	}

	report.print();
	if (report.issues.length > 0) {
		process.exit(1);
	}
}
