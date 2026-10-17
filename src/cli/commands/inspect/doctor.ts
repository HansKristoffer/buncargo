import { existsSync } from "node:fs";
import {
	availableContainerRuntimes,
	type ContainerRuntimeAdapter,
	containerRuntimeForEnv,
	getContainerRuntimeAdapter,
	sweepOrphanedContainers,
} from "../../../container-runtime";
import {
	describeLoopbackHijack,
	doctorFixHosts,
	isRouteLive,
	loadHostRoutes,
	OUTDATED_DAEMON_MESSAGE,
	type ProxyHealth,
	RELOAD_STALL_MS,
	readDaemonConfig,
	readHostsDaemonHealth,
} from "../../../core/hosts";
import { isCaPresent } from "../../../core/hosts/mkcert";
import { describeStaleHostsService } from "../../../core/hosts/service";
import {
	barDecline,
	isBarSupported,
	readInstalledBarInfo,
} from "../../../core/menubar";
import {
	describeOffsetClaimOverlap,
	overlappingOffsetClaims,
	sharedProjectNameClaims,
} from "../../../core/offset-claims";
import {
	foreignLockfile,
	getPortsLockfilePath,
	readOffsetClaimsWithPorts,
	readPortsLockfile,
} from "../../../core/port-allocation";
import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
	withBindProbe,
} from "../../../core/process";
import {
	REGISTRY_VERSION,
	readAllRuns,
	runLivenessAsync,
} from "../../../core/run-registry";
import { isHostsForcedOff } from "../../../core/runtime-flags";
import { describeSwept } from "../../../core/watchdog-loop";
import { loadDevEnv } from "../../../loader";
import type { AnyDevEnvironment } from "../../../types";
import { describeCheckFailures, isWarning, runChecks } from "../../checks";
import { allChecks } from "../../core-checks";
import { hasFlag } from "../../flags";
import * as log from "../../log";
import {
	getTunnelRegistryPath,
	readLiveTunnelRegistry,
} from "../../tunnel-registry";
import {
	type FileHolder,
	type FileTableUsage,
	readFileTableUsage,
	readTopFileHolders,
} from "./file-table";

type DevEnv = Awaited<ReturnType<typeof loadDevEnv>>;

/** Every setup check, core, config and integrations; `setup` fixes what fails. */
async function checkSetupChecks(
	report: DoctorReport,
	env: DevEnv,
): Promise<void> {
	const anyEnv = env as AnyDevEnvironment;
	for (const result of await runChecks(allChecks(anyEnv), {
		root: env.root,
		env: anyEnv,
	})) {
		const [line] = describeCheckFailures([result]);
		if (result.ok) report.note(result.check.name);
		else if (isWarning(result)) report.note(`warning: ${line}`);
		else report.issue(`${line} (\`buncargo setup\` offers the fix)`);
	}
}

/** Above this share of the open-file table, name who holds the most. */
const FILE_TABLE_NOTE = 0.5;
const FILE_TABLE_ISSUE = 0.8;

export function describeFileTable(
	usage: FileTableUsage,
	holders: () => FileHolder[],
): { level: "note" | "issue"; lines: string[] } {
	const share = usage.open / usage.max;
	const lines = [
		`Open files: ${usage.open.toLocaleString("en")} of ${usage.max.toLocaleString("en")} (${Math.round(share * 100)}%)`,
	];
	if (share >= FILE_TABLE_NOTE)
		for (const holder of holders())
			lines.push(
				`  ${holder.files.toLocaleString("en")} held by ${holder.command || "?"} (pid ${holder.pid})`,
			);
	return { level: share >= FILE_TABLE_ISSUE ? "issue" : "note", lines };
}

function checkFileTable(report: DoctorReport): void {
	const usage = readFileTableUsage();
	if (!usage) return;
	const { level, lines } = describeFileTable(usage, () => readTopFileHolders());
	const message = lines.join("\n");
	if (level === "issue")
		report.issue(
			`${message}\n  Near the limit, tools fail with ENFILE. A dev server under \`bun --watch\` leaks descriptors on every reload: use the app's \`watch\` config instead.`,
		);
	else report.note(message);
}

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

	const lookup = withBindProbe((port) =>
		getPortOwner(port, { runtime, fallbackRuntimes }),
	);
	for (const [name, port] of Object.entries(env.ports)) {
		const owner = lookup(port);
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
	const foreign = foreignLockfile(lockfile, env);
	if (foreign) {
		report.issue(
			`Stale ${getPortsLockfilePath(env.root)}: ${foreign}. Delete it or run buncargo dev to rewrite it.`,
		);
		return;
	}
	report.note(`ports.json offset ${lockfile.offset} looks consistent`);
}

/** Two checkouts whose blocks overlap collide whenever both run (a lost race, a copied lockfile). */
function checkOffsetClaims(report: DoctorReport): void {
	const claims = readOffsetClaimsWithPorts();
	for (const overlap of overlappingOffsetClaims(claims))
		report.issue(
			`${describeOffsetClaimOverlap(overlap)}. Move one: \`buncargo ports pin <offset>\` in that checkout.`,
		);
	// Claimed before runs refused a shared name: they share one database.
	for (const [projectName, holders] of sharedProjectNameClaims(claims))
		report.issue(
			`Compose project ${projectName} is used by ${holders.join(" and ")}, so they share its containers and volumes. Give one its own projectPrefix and start it once, or release the claims of one that no longer runs under it: \`buncargo ports release --root <path>\`.`,
		);
}

async function checkOrphanedContainers(
	report: DoctorReport,
	env: DevEnv,
	runtime: ContainerRuntimeAdapter,
): Promise<void> {
	if (!runtime.isAvailable()) return;
	try {
		const result = await sweepOrphanedContainers({
			runtimes: [runtime],
			except: { projectName: env.projectName, root: env.root },
		});
		for (const stack of result.swept) report.note(describeSwept(stack));
		for (const failure of result.failed)
			report.issue(
				`Could not remove ${failure.projectName} (${failure.root}): ${failure.error}`,
			);
		// Not this user's to remove: another user's buncargo on a shared
		// daemon, or state that was wiped. Said, never touched.
		for (const stack of result.foreign)
			report.note(
				`warning: ${stack.projectName} (${stack.root || "no checkout recorded"}, ${stack.runtime}) is not in this user's runs or port claims, and ${stack.reason}. It belongs to another user's buncargo or to wiped state, so it is left alone. If it is orphaned, remove it by hand: ${stack.command}`,
			);
		// Same project name from another checkout, still owned: a run in a
		// worktree that resolved to this project's identity. Survived the
		// sweep, so somebody is using them — say who, because the fix is to
		// go and stop that run, not to guess.
		const foreignRoots = new Set(
			result.remaining
				.filter(
					(group) =>
						group.projectName === env.projectName &&
						group.root &&
						group.root !== env.root,
				)
				.map((group) => group.root),
		);
		for (const root of foreignRoots) {
			const owner = result.runs.find(
				(run) => run.root === root && run.projectName === env.projectName,
			);
			const who = owner
				? `${owner.worktree ?? "the main checkout"}${result.liveSessions.has(owner.sessionId) ? `, running as pid ${owner.pid}` : ", finished and being held"}`
				: "no run on record";
			report.issue(
				`Containers labeled ${env.projectName} belong to ${root} (${who})`,
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
	const after = await readLiveTunnelRegistry(env.root);
	report.note(
		after.length === 0
			? "Tunnel registry is empty"
			: `Tunnel registry has ${after.length} live ${after.length === 1 ? "entry" : "entries"}`,
	);
}

async function checkNamedHosts(
	report: DoctorReport,
	env: DevEnv,
): Promise<void> {
	if (!env.hosts) return;
	// Off (`BUNCARGO_HOSTS=0` or CI): the daemon and its CA are not in use,
	// so neither is a fault.
	if (isHostsForcedOff()) {
		report.note(
			"Named hosts are off (BUNCARGO_HOSTS=0 or CI): apps use http://localhost:port",
		);
		return;
	}
	const health = await readHostsDaemonHealth(readDaemonConfig().httpsPort);
	if (health) {
		report.note("Named-hosts daemon is healthy");
		const hijack = await describeLoopbackHijack();
		if (hijack) report.issue(`Named-hosts: ${hijack}`);
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
	const hostRoutes = (await loadHostRoutes(undefined, { strict: true })).filter(
		(route) => isRouteLive(route),
	);
	report.note(
		hostRoutes.length === 0
			? "Named-hosts route registry is empty"
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
	if (!health) return;
	if (health.outdated) {
		report.issue(`Named-hosts: ${OUTDATED_DAEMON_MESSAGE}`);
		return;
	}

	const served = new Set(health.hostnames);
	const missing = registered
		.map((route) => route.hostname)
		.filter((hostname) => !served.has(hostname));
	if (missing.length > 0) {
		report.issue(
			`Named-hosts daemon is not serving ${missing.join(", ")}, which the registry lists. Run \`buncargo doctor --fix\`.`,
		);
	}

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
	fix = false,
): Promise<void> {
	if (available.some((item) => item.name === runtime.name)) return;
	if (!fix) {
		report.issue(
			`${runtime.displayName} is not running. Run buncargo doctor --fix to start it.`,
		);
		return;
	}
	try {
		await runtime.ensureRunning();
		report.note(`${runtime.displayName} was down and has been started`);
	} catch (error) {
		report.fromError(error);
	}
}

/**
 * Say how many runs are registered, and how many of those have ended and
 * only hold their containers for reuse.
 *
 * A report, not a cleanup: the sweep retires what is finished. It is
 * here because "the menu bar shows a project that is not running" is a
 * support question, and this is where someone looks.
 */
async function checkRunRegistry(report: DoctorReport): Promise<void> {
	try {
		const runs = await readAllRuns();
		const active = runs.filter(await runLivenessAsync(runs)).length;
		const held = runs.length - active;
		report.note(
			`${active} active run${active === 1 ? "" : "s"}, ${held} held for reuse`,
		);
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
	const installed = readInstalledBarInfo();
	if (installed) {
		// An app that cannot read the registry shows an empty menu, which reads
		// as a broken `dev` — an issue, not a note.
		if (installed.registryVersion < REGISTRY_VERSION) {
			report.issue(
				`BuncargoBar ${installed.version ?? ""} reads runs.json v${installed.registryVersion}, buncargo writes v${REGISTRY_VERSION} — run \`buncargo bar update\``,
			);
			return;
		}
		report.note(
			`BuncargoBar installed (${installed.path}${installed.version ? `, ${installed.version}` : ""})`,
		);
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
		// Inspect-only: the checkout files check reports their state instead.
		env = await loadDevEnv({ readOnly: true, syncCheckoutFiles: false });
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
	await checkSelectedRuntime(
		report,
		selected,
		available,
		hasFlag(args, "--fix"),
	);

	if (env) {
		report.note(
			`Port offset ${env.portOffset} from ${env.portOffsetProvenance}`,
		);
		checkPortOwnership(report, env, selected);
		checkPortsLockfile(report, env);
		await checkOrphanedContainers(report, env, selected);
		await checkTunnelRegistry(report, env);
		await checkNamedHosts(report, env);
		await checkSetupChecks(report, env);
	}

	await checkRunRegistry(report);
	checkMenuBarApp(report);
	checkFileTable(report);
	checkOffsetClaims(report);

	// Named hosts that are off have no daemon or CA to repair.
	if (hasFlag(args, "--fix") && !isHostsForcedOff()) {
		for (const fixed of await doctorFixHosts()) {
			report.note(fixed);
		}
	}

	report.print();
	if (report.issues.length > 0) {
		process.exit(1);
	}
}
