import { existsSync } from "node:fs";
import {
	availableContainerRuntimes,
	type ContainerRuntimeAdapter,
	containerRuntimeForEnv,
	getContainerRuntimeAdapter,
	listBuncargoContainers,
} from "../../../container-runtime";
import {
	doctorFixHosts,
	type ProxyHealth,
	pruneHostRoutes,
	RELOAD_STALL_MS,
	readDaemonConfig,
	readHostsDaemonHealth,
} from "../../../core/hosts";
import { isCaPresent } from "../../../core/hosts/mkcert";
import { describeStaleHostsService } from "../../../core/hosts/service";
import {
	barDecline,
	findInstalledBar,
	isBarSupported,
} from "../../../core/menubar";
import {
	getPortsLockfilePath,
	readPortsLockfile,
} from "../../../core/port-allocation";
import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
} from "../../../core/process";
import { loadRuns, pruneRuns } from "../../../core/run-registry";
import { loadDevEnv } from "../../../loader";
import { hasFlag } from "../../flags";
import * as log from "../../log";
import {
	getTunnelRegistryPath,
	pruneTunnelRegistry,
} from "../../tunnel-registry";

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

function checkPortOwnership(
	report: DoctorReport,
	env: DevEnv,
	runtime: ContainerRuntimeAdapter,
): void {
	// doctor is the command people run *because* something is wrong, so it pays
	// the extra probe to spot a container the other backend is holding a port with.
	const fallbackRuntimes = availableContainerRuntimes().filter(
		(candidate) => candidate.name !== runtime.name,
	);

	for (const [name, port] of Object.entries(env.ports)) {
		const owner = getPortOwner(port, { runtime, fallbackRuntimes });
		if (!owner) continue;
		const action = classifyPortOccupant(owner, {
			root: env.root,
			projectName: env.projectName,
			runtime: runtime.name,
		});
		if (action === "fail") {
			report.issue(formatPortOwner(port, owner, { runtime: runtime.name }));
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

function checkForeignContainers(
	report: DoctorReport,
	env: DevEnv,
	runtime: ContainerRuntimeAdapter,
): void {
	if (!runtime.isAvailable()) return;
	try {
		const orphans = listBuncargoContainers([runtime]).filter(
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
	const health = await readHostsDaemonHealth(readDaemonConfig().httpsPort);
	if (health) {
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
	reportDaemonRouteGap(report, health, hostRoutes);
}

/**
 * The registry and the daemon disagreeing is the failure that has no symptom
 * of its own: both halves look fine on their own, and only the browser sees
 * the 404. Naming it here is the difference between a five-minute look and a
 * three-day one.
 */
function reportDaemonRouteGap(
	report: DoctorReport,
	health: ProxyHealth | undefined,
	registered: Array<{ hostname: string }>,
): void {
	if (!health?.hostnames) return;

	const served = new Set(health.hostnames);
	const missing = registered
		.map((route) => route.hostname)
		.filter((hostname) => !served.has(hostname));
	if (missing.length > 0) {
		report.issue(
			`Named-hosts daemon is not serving ${missing.join(", ")}, which the registry lists. Run \`buncargo doctor --fix\`.`,
		);
	}

	if (health.lastReloadAt === undefined) return;
	const ageMs = Date.now() - health.lastReloadAt;
	if (ageMs > RELOAD_STALL_MS) {
		report.issue(
			`Named-hosts daemon has not refreshed its routes in ${Math.round(ageMs / 1000)}s. Run \`buncargo hosts install\` to restart it.`,
		);
	}
}

/**
 * Bring the project's runtime up rather than only reporting that it is down.
 *
 * This is the same preflight `dev` runs, so doctor starts Docker Desktop /
 * OrbStack / Colima or `container system start` the way a real run would, and a
 * failure carries that runtime's own remediation instead of a second copy of it
 * that could drift. Auto-start is off in CI, where it degrades to the message.
 */
async function checkSelectedRuntime(
	report: DoctorReport,
	runtime: ContainerRuntimeAdapter,
	available: ContainerRuntimeAdapter[],
): Promise<void> {
	if (available.some((item) => item.name === runtime.name)) return;
	try {
		await runtime.ensureRunning();
		report.note(`${runtime.displayName} was down and has been started`);
	} catch (error) {
		report.fromError(error);
	}
}

/**
 * Prune runs whose owner is gone, and say how many.
 *
 * The registry prunes itself on every read, so this is really a report. It is
 * here because "the menu bar shows a project that is not running" is a support
 * question, and this is where someone looks.
 */
async function checkRunRegistry(report: DoctorReport): Promise<void> {
	try {
		const before = (await loadRuns()).length;
		const after = (await pruneRuns()).length;
		if (before !== after) {
			report.note(
				`Pruned ${before - after} stale run entr${before - after === 1 ? "y" : "ies"}`,
			);
		}
		report.note(`${after} active run${after === 1 ? "" : "s"} registered`);
	} catch (error) {
		report.issue(
			`Could not read the run registry: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Report the menu bar app, and never install it.
 *
 * It is optional, and a `--fix` pass must not start a download nobody asked
 * for.
 */
function checkMenuBarApp(report: DoctorReport): void {
	if (!isBarSupported()) return;
	const installed = findInstalledBar();
	if (installed) {
		report.note(`BuncargoBar installed (${installed})`);
		return;
	}
	report.note(
		barDecline.has()
			? "BuncargoBar declined — `buncargo bar install` adds it"
			: "BuncargoBar not installed — `buncargo bar install` adds it",
	);
}

export async function handleDoctor(args: string[] = []): Promise<void> {
	const report = new DoctorReport();

	// The config is read first because it can point either runtime at a binary
	// off `PATH`, which the probe below has to use or it reports a false "down".
	let env: DevEnv | undefined;
	try {
		env = await loadDevEnv();
	} catch (error) {
		report.issue(
			`Could not load dev config: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const available = availableContainerRuntimes({
		runtime: env?.containerRuntime,
		binary: env?.containerRuntimeBinary,
	});
	for (const runtime of available) {
		report.note(`${runtime.displayName} is reachable`);
	}

	// Only the runtime this project selected has to be up; another one being
	// down is not a problem for it, and starting it would be wrong.
	const selected = env
		? containerRuntimeForEnv(env)
		: getContainerRuntimeAdapter("docker");
	await checkSelectedRuntime(report, selected, available);

	if (env) {
		report.note(
			`Port offset ${env.portOffset} from ${env.portOffsetProvenance}`,
		);
		checkPortOwnership(report, env, selected);
		checkPortsLockfile(report, env);
		checkForeignContainers(report, env, selected);
		await checkTunnelRegistry(report, env);
		await checkNamedHosts(report, env);
	}

	await checkRunRegistry(report);
	checkMenuBarApp(report);

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
