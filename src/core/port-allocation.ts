import { join } from "node:path";
import { mapValues } from "hanzio";
import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import type {
	AppConfig,
	ContainerRuntimeName,
	PortOffsetProvenance,
	ServiceConfig,
} from "../types";
import { simpleHash } from "./hash";
import {
	claimOffset,
	type OffsetClaim,
	offsetClaimConflict,
	offsetClaimConflicts,
	offsetClaimHoldsBlock,
	offsetClaimKey,
	projectNameClaimant,
	readAllOffsetClaims,
	readOffsetClaims,
	withOffsetClaimsLock,
} from "./offset-claims";
import { type BlockedOffset, PortBlockExhaustedError } from "./port-exhaustion";
import { enclosingWorktreeName, type PortMap } from "./ports";
import {
	type CheckoutStacks,
	classifyPortOccupant,
	createPortOwnerSnapshot,
	formatPortOwner,
	type PortOwner,
	withBindProbe,
} from "./process";
import { readJsonDocumentSync, writeJsonDocumentSync } from "./registry-file";
import { portOffsetOverride } from "./runtime-flags";
import { STATE_DIRNAME } from "./state-paths";
import { formatWarn } from "./style";

export const PORT_OFFSET_STEP = 100;
const PORT_OFFSET_MIN = 100;
/**
 * The last offset the hash spreads checkouts over. Fixed: changing it would
 * move every checkout's hashed block, and the URLs of every one without a
 * lockfile. The search for a free block goes further ({@link maxPortOffset}).
 */
const HASHED_OFFSET_MAX = 9000;
const PORTS_LOCKFILE = `${STATE_DIRNAME}/ports.json`;
const LOCKFILE_VERSION = 1;
const PORT_OFFSET_BUCKETS =
	(HASHED_OFFSET_MAX - PORT_OFFSET_MIN) / PORT_OFFSET_STEP + 1;
/**
 * The first port of Linux's ephemeral range (32768-60999); macOS's starts
 * higher, at 49152. The kernel hands these to outgoing connections, so a block
 * in it would now and then find a port taken by a browser's or a database
 * client's socket and move. Allocated ports stay below the lower of the two.
 */
const EPHEMERAL_PORT_FLOOR = 32768;

/**
 * The highest offset a search for a free block tries: as far as the config's
 * highest port can go and stay below {@link EPHEMERAL_PORT_FLOOR}, and never
 * below the hashed range. A machine with dozens of worktrees filled the 90
 * blocks up to 9000 while a config whose ports end near 8000 has room for 240.
 */
export function maxPortOffset(ports: readonly number[]): number {
	const highest = Math.max(0, ...ports);
	const fits =
		Math.floor((EPHEMERAL_PORT_FLOOR - 1 - highest) / PORT_OFFSET_STEP) *
		PORT_OFFSET_STEP;
	return Math.max(HASHED_OFFSET_MAX, fits);
}

/**
 * `.buncargo/ports.json`. Only `offset` is required: a hand-written
 * `{ "offset": 2500 }` pins the checkout, and the next run fills in the rest.
 */
export interface PortLockfile {
	version: number;
	projectName?: string;
	root?: string;
	offset: number;
	ports: Record<string, number>;
	provenance: Exclude<PortOffsetProvenance, "env" | "unallocated">;
}

export interface PortPlan {
	offset: number;
	ports: PortMap;
	provenance: PortOffsetProvenance;
}

export function computeBaseOffset(options: {
	projectPrefix: string;
	worktreeName?: string | null;
	suffix?: string;
	worktreeIsolation?: boolean;
}): number {
	const {
		projectPrefix,
		worktreeName,
		suffix,
		worktreeIsolation = true,
	} = options;
	const parts = [projectPrefix];
	if (worktreeIsolation && worktreeName) {
		parts.push(worktreeName);
	}
	if (suffix) {
		parts.push(suffix);
	}
	const bucket = simpleHash(parts.join(":")) % PORT_OFFSET_BUCKETS;
	return PORT_OFFSET_MIN + bucket * PORT_OFFSET_STEP;
}

/**
 * Every block an allocation tries, in order: the hashed one, up to `max`,
 * then around from the first. Climbing from the hash alone never reached the
 * blocks below it, which left a checkout that hashed high a few dozen.
 */
function candidateOffsets(hashed: number, max: number): number[] {
	const count = (max - PORT_OFFSET_MIN) / PORT_OFFSET_STEP + 1;
	const first = (hashed - PORT_OFFSET_MIN) / PORT_OFFSET_STEP;
	return Array.from(
		{ length: count },
		(_, index) =>
			PORT_OFFSET_MIN + ((first + index) % count) * PORT_OFFSET_STEP,
	);
}

/**
 * Build the full `name -> port` map for a config, with `offset` applied.
 *
 * Services contribute their `port` plus a `<name>Secondary` entry when they
 * declare a `secondaryPort`; apps contribute their `port`. This is the single
 * place port numbers are derived, so base ports (offset 0) and shifted ports
 * always agree on key naming.
 */
export function buildPortMap(
	services: Record<string, ServiceConfig>,
	apps: Record<string, AppConfig> | undefined,
	offset = 0,
): Record<string, number> {
	const ports: Record<string, number> = {};
	for (const [name, config] of Object.entries(services)) {
		if (config.port !== undefined) ports[name] = config.port + offset;
		if (config.secondaryPort) {
			ports[`${name}Secondary`] = config.secondaryPort + offset;
		}
	}
	if (apps) {
		for (const [name, config] of Object.entries(apps)) {
			if (config.port !== undefined) ports[name] = config.port + offset;
		}
	}
	return ports;
}

/**
 * Each app's `extraPorts`, moved with the app's own port, keyed
 * `<app>#<index>`: they are claimed and probed with the block, but are no
 * port of the config's, so they never reach the env or the lockfile.
 */
export function extraPortMap(
	apps: Record<string, AppConfig> | undefined,
	ports: Record<string, number>,
	basePorts: Record<string, number>,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(apps ?? {}).flatMap(([name, app]) => {
			const port = ports[name];
			const base = basePorts[name];
			if (port === undefined || base === undefined) return [];
			return (app.extraPorts ?? []).map((extra, index) => [
				`${name}#${index}`,
				extra + port - base,
			]);
		}),
	);
}

/** The app or service an entry of the port map (or {@link extraPortMap}) belongs to. */
function portOwnerName(key: string): string {
	return key.split("#")[0] ?? key;
}

/**
 * Ports an allocation can inspect, for one scoped asynchronous cwd reading.
 * Only the hashed range's blocks: the search goes higher only when every one
 * of them is taken, and a block there costs one lookup of its own then,
 * rather than every run reading the processes on every port up to 32767.
 */
export function candidateAllocationPorts(
	input: Pick<
		Parameters<typeof resolvePortPlan>[0],
		| "projectPrefix"
		| "worktreeName"
		| "suffix"
		| "worktreeIsolation"
		| "services"
		| "apps"
		| "probeNames"
	>,
	currentOffset: number,
): number[] {
	const base = buildPortMap(input.services, input.apps);
	const block = { ...base, ...extraPortMap(input.apps, base, base) };
	const offsets = new Set([
		currentOffset,
		...candidateOffsets(computeBaseOffset(input), HASHED_OFFSET_MAX),
	]);
	return Object.entries(block)
		.filter(
			([name]) =>
				!input.probeNames || input.probeNames.includes(portOwnerName(name)),
		)
		.flatMap(([, base]) => [...offsets].map((offset) => base + offset))
		.filter((port) => port > 0 && port <= 65535);
}

function shiftPorts(
	basePorts: Record<string, number>,
	offset: number,
): Record<string, number> {
	return mapValues(basePorts, (port) => port + offset);
}

export function getPortsLockfilePath(root: string): string {
	return join(root, PORTS_LOCKFILE);
}

function validatePortLockfile(value: unknown): PortLockfile | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const lockfile = value as Partial<PortLockfile>;
	if (lockfile.version !== undefined && lockfile.version !== LOCKFILE_VERSION)
		return undefined;
	if (!Number.isInteger(lockfile.offset) || (lockfile.offset ?? -1) < 0)
		return undefined;
	for (const field of ["projectName", "root"] as const)
		if (lockfile[field] !== undefined && typeof lockfile[field] !== "string")
			return undefined;
	const ports = lockfile.ports ?? {};
	if (
		typeof ports !== "object" ||
		ports === null ||
		Object.values(ports).some(
			(port) => !Number.isInteger(port) || port < 1 || port > 65535,
		)
	)
		return undefined;
	const provenance = lockfile.provenance ?? "lockfile";
	if (
		provenance !== "hash" &&
		provenance !== "lockfile" &&
		provenance !== "shifted"
	)
		return undefined;
	return {
		...lockfile,
		version: LOCKFILE_VERSION,
		offset: lockfile.offset as number,
		ports,
		provenance,
	};
}

/** Why a lockfile is not this checkout's, or undefined when it is. */
export function foreignLockfile(
	lockfile: PortLockfile,
	input: { projectName: string; root: string },
): string | undefined {
	if (lockfile.root !== undefined && lockfile.root !== input.root)
		return `it was written for ${lockfile.root}`;
	if (
		lockfile.projectName !== undefined &&
		lockfile.projectName !== input.projectName
	)
		return `it was written for project ${lockfile.projectName}`;
	return undefined;
}

export function readPortsLockfile(root: string): PortLockfile | null {
	return (
		readJsonDocumentSync(getPortsLockfilePath(root), validatePortLockfile) ??
		null
	);
}

export function writePortsLockfile(root: string, lockfile: PortLockfile): void {
	writeJsonDocumentSync(getPortsLockfilePath(root), lockfile);
}

/**
 * The claims of existing checkouts as allocation weighs them: a port-less
 * claim holds the ports its checkout's lockfile records. What `doctor` and
 * `buncargo ports` report overlaps from.
 */
export function readOffsetClaimsWithPorts(): Record<string, OffsetClaim> {
	return claimsWithLockfilePorts(readOffsetClaims());
}

/**
 * The claims that hold a block, with a port-less claim's ports read from its
 * checkout's lockfile. A reclaimed claim holds none: it keeps its project
 * name, but its block is another checkout's to take.
 *
 * A claim written before claims carried their ports holds only its offset, so
 * a newcomer could take a block overlapping it and the incumbent moved on its
 * next run. Its lockfile still records the block it uses. One read per such
 * claim, and only until that checkout's next run rewrites its claim.
 */
function claimsWithLockfilePorts(
	claims: Record<string, OffsetClaim>,
): Record<string, OffsetClaim> {
	const holding = Object.fromEntries(
		Object.entries(claims).filter(([, claim]) => offsetClaimHoldsBlock(claim)),
	);
	return mapValues(holding, (claim, key) => {
		// A suffixed environment has no lockfile; its checkout's is dev's.
		if (claim.ports || claim.suffix) return claim;
		const lockfile = readPortsLockfile(key);
		const ports = lockfile ? Object.values(lockfile.ports) : [];
		if (
			!lockfile ||
			lockfile.offset !== claim.offset ||
			foreignLockfile(lockfile, {
				projectName: claim.projectName,
				root: key,
			}) ||
			ports.length === 0
		)
			return claim;
		return { ...claim, ports: ports.sort((a, b) => a - b) };
	});
}

/**
 * A clause naming who holds `port`, to embed in a sentence. `runtime` is the
 * selected backend, so a container on the other one says how to stop it.
 */
export function describePortConflict(
	port: number,
	owner: PortOwner | null,
	runtime?: ContainerRuntimeName,
	checkout?: CheckoutStacks,
): string {
	if (!owner) return `port ${port} is in use`;
	return formatPortOwner(port, owner, { runtime, checkout }).replace(/\.$/, "");
}

function findForeignConflict(
	ports: Record<string, number>,
	options: {
		root: string;
		projectName: string;
		runtime?: ContainerRuntimeName;
		getOwner: (port: number) => PortOwner | null;
	},
): { name: string; port: number; owner: PortOwner } | null {
	for (const [name, port] of Object.entries(ports)) {
		const owner = options.getOwner(port);
		const action = classifyPortOccupant(owner, options);
		if (action === "fail" && owner) {
			return { name, port, owner };
		}
	}
	return null;
}

/**
 * A port-ownership lookup backed by one reading of the system.
 *
 * The shifted blocks this allocator may fall through to are not known up
 * front, so only the base ports are pre-batched for the working-directory
 * lookup; a shifted block that turns out to be occupied costs one extra call.
 */
function snapshotOwnerLookup(
	basePorts: Record<string, number>,
	runtime: ContainerRuntimeAdapter | undefined,
): (port: number) => PortOwner | null {
	const snapshot = createPortOwnerSnapshot({
		runtime,
		ports: Object.values(basePorts),
	});
	return (port) => snapshot.owner(port);
}

export function resolvePortPlan(input: {
	projectPrefix: string;
	projectName: string;
	root: string;
	services: Record<string, ServiceConfig>;
	apps?: Record<string, AppConfig>;
	suffix?: string;
	worktreeName?: string | null;
	worktreeIsolation?: boolean;
	/** Write `.buncargo/ports.json`. Default: true. Only the dev environment has one. */
	persist?: boolean;
	/**
	 * Claim the offset in `~/.buncargo/offsets.json`, so no other checkout or
	 * environment takes it. Default: `persist`. A suffixed environment claims
	 * without persisting: its claim is its only record, and the next run of it
	 * takes the same offset back.
	 */
	claim?: boolean;
	/**
	 * Backend the caller resolved, so this project's own containers are not
	 * mistaken for foreign occupants.
	 *
	 * Without it every lookup asks Docker, and under Apple the port looks like
	 * it is held by the `container` forwarder process rather than by a container
	 * of ours. That reads as a conflict, shifts the offset by
	 * {@link PORT_OFFSET_STEP}, and changes the generated model - which changes
	 * the config hash and recreates the container on every single run.
	 */
	runtime?: ContainerRuntimeAdapter;
	/**
	 * Whether a busy port may shift the block. Default: true.
	 *
	 * A read-only caller wants the ports this environment *uses*, which is
	 * whatever the last real run persisted. Probing there reallocates around
	 * the environment's own running services and answers with a port nothing
	 * is listening on, so `getEnvVar` turns it off.
	 */
	probeConflicts?: boolean;
	getOwner?: (port: number) => PortOwner | null;
	probeNames?: readonly string[];
	/**
	 * Ports outside the map that the block also holds (Tailscale Serve's HTTPS
	 * ports): claimed with it and checked against other checkouts' claims, so
	 * none lands on another block, but never probed, because the checkout's
	 * own serve entry on one fails the bind probe like a stranger would.
	 */
	companionPorts?: (ports: Record<string, number>) => number[];
}): PortPlan {
	const basePorts = buildPortMap(input.services, input.apps);
	for (const [name, port] of Object.entries(basePorts))
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error(
				`Invalid base port for ${name}: ${port}. Expected an integer in 1..65535.`,
			);

	// One reading of the machine for every port this allocator may look at,
	// including the shifted blocks it can fall through to. Probing per port cost
	// an `lsof` and a `docker ps` each, and the allocator is the first thing a
	// dev run does. It is taken before the claims lock: a slow runtime would
	// otherwise hold every other checkout's allocation past the lock's timeout.
	//
	// Reporting no owner is what makes every conflict check pass, so a
	// read-only caller gets the lockfile back rather than a block reallocated
	// around its own running services.
	const getOwner =
		input.probeConflicts === false || portOffsetOverride() !== undefined
			? () => null
			: (input.getOwner ??
				withBindProbe(snapshotOwnerLookup(basePorts, input.runtime)));

	// A claiming run reads the other claims, picks a free offset and claims it:
	// one step, or two runs starting together pick the same.
	const claim = input.claim ?? input.persist !== false;
	const plan = () => planPorts({ ...input, claim, getOwner }, basePorts);
	return claim ? withOffsetClaimsLock(plan) : plan();
}

/**
 * Why `root` may not claim under `projectName`, or undefined when it may:
 * another existing checkout's claim carries the name, so both would run one
 * stack, sharing containers and the database, and one's teardown takes the
 * other's down. A run and `ports pin` both ask it under the claims lock.
 */
function sharedProjectNameRefusal(
	claims: Record<string, OffsetClaim>,
	input: { root: string; projectName: string },
): string | undefined {
	const { root, projectName } = input;
	const claimant = projectNameClaimant(claims, input);
	if (!claimant) return undefined;
	const worktree = enclosingWorktreeName(root);
	const below = worktree
		? ` ${root} is below the top of Git worktree ${worktree}, so the worktree's name is not in its project name: derive projectPrefix from the worktree.`
		: "";
	return `${root} would run under Compose project ${projectName}, which ${claimant.holder} already uses: they would share containers and volumes, the database included. Give one of them its own projectPrefix in dev.config.ts (it may be computed, e.g. from the CI runner's name) or a directory with another name. If you change the other one, start it once so it records its new name, or delete it if it is no longer used. If it no longer runs under this name (its claim is from an older config), release the claim: \`buncargo ports release --root ${claimant.root}\`.${below}`;
}

function planPorts(
	input: Parameters<typeof resolvePortPlan>[0] & {
		getOwner: (port: number) => PortOwner | null;
	},
	basePorts: Record<string, number>,
): PortPlan {
	const {
		projectPrefix,
		projectName,
		root,
		suffix,
		worktreeName = null,
		worktreeIsolation = true,
		persist = true,
		claim = persist,
		runtime,
		probeConflicts = true,
		getOwner: lookupOwner,
	} = input;
	const runtimeName = runtime?.name;
	const checkout = { root, projectPrefix };
	const withExtras = (ports: Record<string, number>) => ({
		...ports,
		...extraPortMap(input.apps, ports, basePorts),
	});

	// Claims of checkouts that still exist. A claiming run reads them before
	// anything else, so a project name another checkout uses stops it before
	// it writes a lockfile or a claim, under any offset.
	const existingClaims = claim ? readOffsetClaims() : undefined;
	if (existingClaims && worktreeIsolation) {
		const refused = sharedProjectNameRefusal(existingClaims, {
			root,
			projectName,
		});
		if (refused) throw new Error(refused);
	}

	const envOffset = portOffsetOverride();
	if (envOffset !== undefined) {
		const ports = shiftPorts(basePorts, envOffset);
		for (const [name, port] of Object.entries(withExtras(ports)))
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				throw new Error(
					`Effective port for ${name} is ${port}; BUNCARGO_PORT_OFFSET must keep every port in 1..65535.`,
				);
		return {
			offset: envOffset,
			ports,
			provenance: "env",
		};
	}

	const probed = (ports: Record<string, number>) =>
		input.probeNames
			? Object.fromEntries(
					Object.entries(ports).filter(([name]) =>
						input.probeNames?.includes(portOwnerName(name)),
					),
				)
			: ports;
	// Other claims are skipped whether or not their runs are running; only a
	// claiming run writes its own.
	const claimKey = offsetClaimKey(root, suffix);
	const blockPorts = (ports: Record<string, number>) => [
		...Object.values(withExtras(ports)),
		...(input.companionPorts?.(ports) ?? []),
	];
	// Every other claim is read only past the read's fast path: a lockfile
	// whose own claim holds its block answers from one read of the file.
	let readClaims: Record<string, OffsetClaim> | undefined;
	const allClaims = () => {
		readClaims ??= claimsWithLockfilePorts(
			existingClaims ?? readOffsetClaims(),
		);
		return readClaims;
	};
	const claimant = (offset: number, ports: Record<string, number>) =>
		offsetClaimConflict(
			allClaims(),
			{ offset, ports: blockPorts(ports) },
			claimKey,
		);
	const lockfile = readPortsLockfile(root);
	const notOurs = lockfile && foreignLockfile(lockfile, { projectName, root });
	const ownLockfile = lockfile && !notOurs ? lockfile : undefined;
	// A full range reclaimed this checkout's block for another one: its
	// lockfile still names the block, and its claim holds none. A live run
	// always holds its claim, so a block two claims share (a pre-lock race)
	// still reads as the lockfile says, as the run serving it does.
	const ownClaimHolds = () => {
		const own = readAllOffsetClaims()[claimKey];
		return own !== undefined && offsetClaimHoldsBlock(own);
	};
	const reclaimed = () =>
		ownLockfile !== undefined &&
		!ownClaimHolds() &&
		claimant(ownLockfile.offset, shiftPorts(basePorts, ownLockfile.offset)) !==
			undefined;
	if (!probeConflicts && ownLockfile && !reclaimed()) {
		// A config edit must not make a maintenance command switch away from
		// the endpoints the last startup published. New keys use the same offset.
		const ports = Object.fromEntries(
			Object.entries(basePorts).map(([name, base]) => [
				name,
				ownLockfile.ports[name] ?? base + ownLockfile.offset,
			]),
		);
		if (Object.values(withExtras(ports)).some((port) => port > 65535))
			throw new Error(
				"Persisted offset cannot accommodate this config; run dev to reconcile the allocation.",
			);
		return { offset: ownLockfile.offset, ports, provenance: "lockfile" };
	}

	const claims = allClaims();
	const conflictAt = (ports: Record<string, number>) =>
		findForeignConflict(probed(withExtras(ports)), {
			root,
			projectName,
			runtime: runtimeName,
			getOwner: lookupOwner,
		});
	const settle = (
		offset: number,
		ports: Record<string, number>,
		provenance: PortLockfile["provenance"],
	): PortPlan => {
		if (persist) {
			const next: PortLockfile = {
				version: LOCKFILE_VERSION,
				projectName,
				root,
				offset,
				ports,
				provenance,
			};
			if (JSON.stringify(next) !== JSON.stringify(lockfile))
				writePortsLockfile(root, next);
		}
		if (claim)
			claimOffset({
				root,
				offset,
				ports: blockPorts(ports),
				projectName,
				suffix,
			});
		return { offset, ports, provenance };
	};

	// The lockfile's offset, applied to whatever ports the config has now: an
	// added service keeps the block, and `{ "offset": 2500 }` alone pins it.
	let ignored = notOurs;
	if (ownLockfile) {
		const ports = shiftPorts(basePorts, ownLockfile.offset);
		// A partial start must not move the block: the containers and apps it
		// did not select still publish the persisted ports.
		const partial =
			input.probeNames &&
			Object.keys(basePorts).some((name) => !input.probeNames?.includes(name));
		const refusePartial = (reason: string, next: string) => {
			if (partial)
				throw new Error(
					`Selected app ports conflict with the persisted allocation: ${reason}. ${next}`,
				);
			return reason;
		};
		const claimed = claimant(ownLockfile.offset, ports);
		if (claimed)
			ignored = refusePartial(
				claimed,
				"Start the full environment to move this checkout's shared port block.",
			);
		else if (Object.values(withExtras(ports)).some((port) => port > 65535))
			ignored = `offset ${ownLockfile.offset} puts a port above 65535`;
		else {
			const conflict = conflictAt(ports);
			if (!conflict) return settle(ownLockfile.offset, ports, "lockfile");
			ignored = refusePartial(
				describePortConflict(
					conflict.port,
					conflict.owner,
					runtimeName,
					checkout,
				),
				"Stop that port's owner, or start the full environment to reconcile its shared port block.",
			);
		}
	}
	const settleAllocated = (
		offset: number,
		ports: Record<string, number>,
		provenance: PortLockfile["provenance"],
	): PortPlan => {
		// Moving off a lockfile changes every URL of the checkout: say why.
		if (persist && lockfile && ignored && lockfile.offset !== offset)
			console.warn(
				formatWarn(
					`.buncargo/ports.json (offset ${lockfile.offset}) not used: ${ignored}. Using offset ${offset}.`,
				),
			);
		return settle(offset, ports, provenance);
	};

	const hashed = computeBaseOffset({
		projectPrefix,
		worktreeName,
		suffix,
		worktreeIsolation,
	});

	// Why the block at `offset` cannot be used, or undefined when it can.
	// Claims are read before the probe, which a claimed block never pays for.
	const blockedAt = (
		offset: number,
		ports: Record<string, number>,
	): BlockedOffset | undefined => {
		if (Object.values(withExtras(ports)).some((port) => port > 65535))
			return {
				offset,
				problem: `offset ${offset} puts a port above 65535`,
				claimKeys: [],
				unusable: true,
			};
		const claimed = offsetClaimConflicts(
			claims,
			{ offset, ports: blockPorts(ports) },
			claimKey,
		);
		const [first] = claimed;
		if (first)
			return {
				offset,
				problem: first.reason,
				claimKeys: claimed.map((conflict) => conflict.key),
				unusable: false,
			};
		const conflict = conflictAt(ports);
		return conflict
			? {
					offset,
					problem: describePortConflict(
						conflict.port,
						conflict.owner,
						runtimeName,
						checkout,
					),
					claimKeys: [],
					unusable: true,
				}
			: undefined;
	};
	const problemAt = (offset: number, ports: Record<string, number>) =>
		blockedAt(offset, ports)?.problem;

	// A suffixed environment has no lockfile; its own claim keeps its ports
	// from one run to the next, as a lockfile does for dev, and read-only
	// callers find the ports its last run used.
	const ownClaim = persist ? undefined : claims[claimKey];
	if (ownClaim) {
		const ports = shiftPorts(basePorts, ownClaim.offset);
		if (!problemAt(ownClaim.offset, ports))
			return settle(
				ownClaim.offset,
				ports,
				ownClaim.offset === hashed ? "hash" : "shifted",
			);
	}

	const maxOffset = maxPortOffset(Object.values(withExtras(basePorts)));
	const blocked: BlockedOffset[] = [];
	for (const offset of candidateOffsets(hashed, maxOffset)) {
		const ports = shiftPorts(basePorts, offset);
		const block = blockedAt(offset, ports);
		if (!block)
			return settleAllocated(
				offset,
				ports,
				offset === hashed ? "hash" : "shifted",
			);
		blocked.push(block);
	}

	// A read answers where the hash puts the block, and says it is not this
	// checkout's: `status`, `env`, `url` and `ports` must work in exactly the
	// state they are needed to get out of, and `ports pin` with them.
	if (!claim)
		return {
			offset: hashed,
			ports: shiftPorts(basePorts, hashed),
			provenance: "unallocated",
		};

	// Only now, with nothing free, does a claimed block pay for a probe: one a
	// process holds stays taken when its claim goes, so it is not worth
	// reclaiming.
	for (const block of blocked)
		if (!block.unusable && conflictAt(shiftPorts(basePorts, block.offset)))
			block.unusable = true;
	throw new PortBlockExhaustedError({
		root,
		range: { min: PORT_OFFSET_MIN, max: maxOffset, hashed },
		blocked,
		claims,
		pinnable: pinnableOffsetAbove(maxOffset, (offset) => {
			const ports = shiftPorts(basePorts, offset);
			return Object.values(withExtras(ports)).some((port) => port > 65535)
				? "overflow"
				: claimant(offset, ports);
		}),
	});
}

/**
 * The first offset above the searched range whose block no claim touches, or
 * undefined when every one up to 65535 is taken. Its ports are in the
 * ephemeral range on Linux, which is why the search stops below it; pinned
 * by hand, it is a way out, not a default.
 */
function pinnableOffsetAbove(
	max: number,
	problemAt: (offset: number) => string | undefined,
): number | undefined {
	for (let offset = max + PORT_OFFSET_STEP; ; offset += PORT_OFFSET_STEP) {
		const problem = problemAt(offset);
		if (problem === "overflow") return undefined;
		if (!problem) return offset;
	}
}

/** What `buncargo ports pin` did: the block's ports, or why it is not free. */
export type PinResult =
	{ pinned: Record<string, number> } | { refused: string; claimed: boolean };

/**
 * `buncargo ports pin`: move `root` to the block at `offset` and keep it there.
 *
 * Every port is probed first, outside the claims lock: binding each one takes
 * a while, and every other checkout's allocation waits on that lock. The claims
 * are read again under the lock before the lockfile and the claim are written,
 * so a checkout that claimed the block in the meantime keeps it.
 */
export function pinOffset(input: {
	root: string;
	projectName: string;
	services: Record<string, ServiceConfig>;
	apps?: Record<string, AppConfig>;
	offset: number;
	/** `options.worktreeIsolation`: without it, sharing the name is asked for. */
	worktreeIsolation?: boolean;
	runtime?: ContainerRuntimeName;
	getOwner: (port: number) => PortOwner | null;
	/** As in {@link resolvePortPlan}: claimed, never probed. */
	companionPorts?: (ports: Record<string, number>) => number[];
}): PinResult {
	const { root, projectName, offset, runtime } = input;
	const ports = buildPortMap(input.services, input.apps, offset);
	const extras = extraPortMap(
		input.apps,
		ports,
		buildPortMap(input.services, input.apps),
	);
	const companions = input.companionPorts?.(ports) ?? [];
	const block = {
		offset,
		ports: [...Object.values(ports), ...Object.values(extras), ...companions],
	};
	// A claim under a name another checkout holds would only make the next
	// run refuse, after the lockfile had moved.
	const claimedBy = (): PinResult | undefined => {
		const claims = readOffsetClaims();
		const shared =
			input.worktreeIsolation === false
				? undefined
				: sharedProjectNameRefusal(claims, { root, projectName });
		if (shared) return { refused: shared, claimed: false };
		const claimed = offsetClaimConflict(
			claimsWithLockfilePorts(claims),
			block,
			root,
		);
		return claimed
			? { refused: `Offset ${offset} is not free: ${claimed}.`, claimed: true }
			: undefined;
	};

	const claimed = claimedBy();
	if (claimed) return claimed;
	for (const port of [...Object.values(ports), ...Object.values(extras)]) {
		if (port > 65535)
			return {
				refused: `Offset ${offset} puts port ${port} above 65535.`,
				claimed: false,
			};
		const owner = input.getOwner(port);
		if (
			owner &&
			classifyPortOccupant(owner, { root, projectName, runtime }) === "fail"
		)
			return {
				refused: `Offset ${offset} is not free: ${describePortConflict(port, owner, runtime)}.`,
				claimed: false,
			};
	}

	return withOffsetClaimsLock((): PinResult => {
		const claimedMeanwhile = claimedBy();
		if (claimedMeanwhile) return claimedMeanwhile;
		writePortsLockfile(root, {
			version: LOCKFILE_VERSION,
			projectName,
			root,
			offset,
			ports,
			provenance: "lockfile",
		});
		claimOffset({ root, offset, ports: block.ports, projectName });
		return { pinned: ports };
	});
}
