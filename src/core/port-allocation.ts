import { join } from "node:path";
import { mapValues } from "hanzio";
import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import type { ContainerRuntimeName, PortOffsetProvenance } from "../types";
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

/** The ports a service declares: a resolved one or one as written. */
export interface PortedService {
	port?: number;
	secondaryPort?: number;
}

/** The ports an app declares: a resolved one or one as written. */
export interface PortedApp {
	port?: number;
	extraPorts?: readonly number[];
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
	services: Readonly<Record<string, PortedService>>,
	apps: Readonly<Record<string, PortedApp>> | undefined,
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
	apps: Readonly<Record<string, PortedApp>> | undefined,
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
		AllocatePortBlockInput,
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

/** What decides an environment's block: its checkout, its config and its suffix. */
export interface PortPlanInput {
	projectPrefix: string;
	projectName: string;
	root: string;
	services: Readonly<Record<string, PortedService>>;
	apps?: Readonly<Record<string, PortedApp>>;
	suffix?: string;
	worktreeName?: string | null;
	worktreeIsolation?: boolean;
	/**
	 * Ports outside the map that the block also holds (Tailscale Serve's HTTPS
	 * ports): claimed with it and checked against other checkouts' claims, so
	 * none lands on another block, but never probed, because the checkout's
	 * own serve entry on one fails the bind probe like a stranger would.
	 */
	companionPorts?: (ports: Record<string, number>) => number[];
}

export interface AllocatePortBlockInput extends PortPlanInput {
	/**
	 * Claim the block in `~/.buncargo/offsets.json`, so no other checkout or
	 * environment takes it. Without it the allocation is a dry run: it probes
	 * and writes nothing.
	 */
	claim: boolean;
	/**
	 * Write `.buncargo/ports.json`. Default: `claim`, for the dev environment
	 * only. A suffixed environment claims without persisting: its claim is its
	 * only record, and the next run of it takes the same block back.
	 */
	persist?: boolean;
	/**
	 * The claim should not outlive its run (a suffixed environment, any in
	 * CI): recorded on it, so the sweep frees it once its run is gone, even
	 * when the run was killed before its teardown released it.
	 */
	throwaway?: boolean;
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
	getOwner?: (port: number) => PortOwner | null;
	probeNames?: readonly string[];
}

/**
 * The ports an environment uses (`readPortPlan`) or an allocation for a run
 * (`allocatePortBlock`). `probeConflicts: false` is the read; otherwise
 * `claim` defaults to `persist`, and `persist` to true.
 */
export function resolvePortPlan(
	input: Omit<AllocatePortBlockInput, "claim"> & {
		claim?: boolean;
		probeConflicts?: boolean;
	},
): PortPlan {
	if (input.probeConflicts === false) return readPortPlan(input);
	const persist = input.persist ?? true;
	return allocatePortBlock({
		...input,
		persist,
		claim: input.claim ?? persist,
	});
}

/** One block an allocation may take: its offset, and every port it holds. */
export interface BlockCandidate {
	offset: number;
	/** The config's ports at `offset`, apps' extra ports and companion ports included. */
	ports: readonly number[];
}

/**
 * The first candidate no claim and no process is in the way of, or why each
 * one is blocked, in order.
 *
 * `claims` are the other environments' claims that hold a block. `busy` says
 * why a process holds a port of the block at `offset`, or undefined when none
 * does; a claimed block or one with a port above 65535 is never probed.
 */
export function chooseBlock(
	candidates: Iterable<BlockCandidate>,
	claims: Record<string, OffsetClaim>,
	busy: (offset: number) => string | undefined,
): { offset: number } | { blocked: BlockedOffset[] } {
	const blocked: BlockedOffset[] = [];
	for (const { offset, ports } of candidates) {
		if (ports.some((port) => port > 65535)) {
			blocked.push({
				offset,
				problem: `offset ${offset} puts a port above 65535`,
				claimKeys: [],
				unusable: true,
			});
			continue;
		}
		const claimed = offsetClaimConflicts(claims, { offset, ports });
		const [first] = claimed;
		if (first) {
			blocked.push({
				offset,
				problem: first.reason,
				claimKeys: claimed.map((conflict) => conflict.key),
				unusable: false,
			});
			continue;
		}
		const problem = busy(offset);
		if (!problem) return { offset };
		blocked.push({ offset, problem, claimKeys: [], unusable: true });
	}
	return { blocked };
}

/** An environment's ports at any offset, and the blocks it searches. */
function portLayout(input: PortPlanInput) {
	const basePorts = buildPortMap(input.services, input.apps);
	for (const [name, port] of Object.entries(basePorts))
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error(
				`Invalid base port for ${name}: ${port}. Expected an integer in 1..65535.`,
			);
	const withExtras = (ports: Record<string, number>) => ({
		...ports,
		...extraPortMap(input.apps, ports, basePorts),
	});
	const at = (offset: number) => shiftPorts(basePorts, offset);
	const candidate = (offset: number): BlockCandidate => {
		const ports = at(offset);
		return {
			offset,
			ports: [
				...Object.values(withExtras(ports)),
				...(input.companionPorts?.(ports) ?? []),
			],
		};
	};
	const hashed = computeBaseOffset({
		projectPrefix: input.projectPrefix,
		worktreeName: input.worktreeName ?? null,
		suffix: input.suffix,
		worktreeIsolation: input.worktreeIsolation,
	});
	const maxOffset = maxPortOffset(Object.values(withExtras(basePorts)));
	return {
		basePorts,
		withExtras,
		at,
		candidate,
		hashed,
		maxOffset,
		claimKey: offsetClaimKey(input.root, input.suffix),
		provenance: (offset: number): "hash" | "shifted" =>
			offset === hashed ? "hash" : "shifted",
		/** The hashed block, then up to `maxOffset`, then around from the first. */
		*search(): Generator<BlockCandidate> {
			for (const offset of candidateOffsets(hashed, maxOffset))
				yield candidate(offset);
		},
	};
}

type PortLayout = ReturnType<typeof portLayout>;

/** `BUNCARGO_PORT_OFFSET`'s block, which nothing probes or claims. */
function overridePlan(layout: PortLayout, offset: number): PortPlan {
	const ports = layout.at(offset);
	for (const [name, port] of Object.entries(layout.withExtras(ports)))
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error(
				`Effective port for ${name} is ${port}; BUNCARGO_PORT_OFFSET must keep every port in 1..65535.`,
			);
	return { offset, ports, provenance: "env" };
}

/** The checkout's lockfile, and why it is set aside when it is another's. */
function readOwnLockfile(input: PortPlanInput): {
	lockfile: PortLockfile | null;
	own: PortLockfile | undefined;
	foreign: string | undefined;
} {
	const lockfile = readPortsLockfile(input.root);
	const foreign = lockfile ? foreignLockfile(lockfile, input) : undefined;
	return {
		lockfile,
		own: lockfile && !foreign ? lockfile : undefined,
		foreign,
	};
}

/** The claims that hold a block, without the asker's own (`key`). */
function otherClaims(
	claims: Record<string, OffsetClaim>,
	key: string,
): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(claims).filter(([other]) => other !== key),
	);
}

/**
 * The ports an environment uses, probing nothing and writing nothing: what
 * its last run persisted, its own claim, or the first block no claim holds.
 *
 * A read wants the ports this environment *uses*. Probing there reallocates
 * around the environment's own running services and answers with a port
 * nothing is listening on, so `getEnvVar` reads.
 */
export function readPortPlan(input: PortPlanInput): PortPlan {
	const layout = portLayout(input);
	const envOffset = portOffsetOverride();
	if (envOffset !== undefined) return overridePlan(layout, envOffset);

	// The lockfile answers from one read of the claims file, unless a full
	// range reclaimed this checkout's block for another one: the lockfile still
	// names it, and the claim holds none. A live run always holds its claim, so
	// a block two claims share (a pre-lock race) still reads as the lockfile
	// says, as the run serving it does.
	let read:
		{ own?: OffsetClaim; others: Record<string, OffsetClaim> } | undefined;
	const claims = () => {
		if (!read) {
			const holding = claimsWithLockfilePorts(readOffsetClaims());
			read = {
				own: holding[layout.claimKey],
				others: otherClaims(holding, layout.claimKey),
			};
		}
		return read;
	};
	const { own: lockfile } = readOwnLockfile(input);
	if (lockfile) {
		const ownClaim = readAllOffsetClaims()[layout.claimKey];
		const reclaimed =
			(ownClaim === undefined || !offsetClaimHoldsBlock(ownClaim)) &&
			offsetClaimConflict(
				claims().others,
				layout.candidate(lockfile.offset),
			) !== undefined;
		if (!reclaimed) return lockfilePlan(layout, lockfile);
	}

	// Its own claim keeps a suffixed environment's ports from one run to the
	// next, as a lockfile does for dev.
	const { own, others } = claims();
	const free = () => undefined;
	const ownChoice =
		own && chooseBlock([layout.candidate(own.offset)], others, free);
	const choice =
		ownChoice && "offset" in ownChoice
			? ownChoice
			: chooseBlock(layout.search(), others, free);
	// Every block is someone else's: answer where the hash puts it, and say
	// it is not this checkout's. `status`, `env`, `url` and `ports` must work
	// in exactly the state they are needed to get out of, and `ports pin`
	// with them.
	if (!("offset" in choice))
		return {
			offset: layout.hashed,
			ports: layout.at(layout.hashed),
			provenance: "unallocated",
		};
	return {
		offset: choice.offset,
		ports: layout.at(choice.offset),
		provenance: layout.provenance(choice.offset),
	};
}

/**
 * The lockfile's ports, and its offset for keys it does not have: a config
 * edit must not make a maintenance command switch away from the endpoints the
 * last startup published.
 */
function lockfilePlan(layout: PortLayout, lockfile: PortLockfile): PortPlan {
	const ports = mapValues(
		layout.basePorts,
		(base, name) => lockfile.ports[name] ?? base + lockfile.offset,
	);
	if (Object.values(layout.withExtras(ports)).some((port) => port > 65535))
		throw new Error(
			"Persisted offset cannot accommodate this config; run dev to reconcile the allocation.",
		);
	return { offset: lockfile.offset, ports, provenance: "lockfile" };
}

/**
 * The block a run takes: the lockfile's, a suffixed environment's own claim,
 * or the first free one from the hash. Probes for processes on the ports, and
 * with `claim` claims the block under the claims lock, which it holds from
 * reading the other claims to writing its own: two runs starting together
 * would otherwise pick the same.
 *
 * Throws {@link PortBlockExhaustedError} when a claiming run finds every
 * block taken; a dry run answers `unallocated` then, as a read does.
 */
export function allocatePortBlock(input: AllocatePortBlockInput): PortPlan {
	const layout = portLayout(input);
	// One reading of the machine for every port this allocator may look at,
	// including the shifted blocks it can fall through to. Probing per port cost
	// an `lsof` and a `docker ps` each, and the allocator is the first thing a
	// dev run does. It is taken before the claims lock: a slow runtime would
	// otherwise hold every other checkout's allocation past the lock's timeout.
	const getOwner =
		portOffsetOverride() !== undefined
			? () => null
			: (input.getOwner ??
				withBindProbe(snapshotOwnerLookup(layout.basePorts, input.runtime)));
	const allocate = () => allocateBlock(input, layout, getOwner);
	return input.claim ? withOffsetClaimsLock(allocate) : allocate();
}

function allocateBlock(
	input: AllocatePortBlockInput,
	layout: PortLayout,
	getOwner: (port: number) => PortOwner | null,
): PortPlan {
	const { projectName, root, suffix, claim, runtime } = input;
	const persist = input.persist ?? (claim && suffix === undefined);
	const runtimeName = runtime?.name;

	// Claims of checkouts that still exist. A claiming run reads them before
	// anything else, so a project name another checkout uses stops it before
	// it writes a lockfile or a claim, under any offset.
	const existingClaims = readOffsetClaims();
	if (claim && (input.worktreeIsolation ?? true)) {
		const refused = sharedProjectNameRefusal(existingClaims, {
			root,
			projectName,
		});
		if (refused) throw new Error(refused);
	}

	const envOffset = portOffsetOverride();
	if (envOffset !== undefined) return overridePlan(layout, envOffset);

	// Other claims are skipped whether or not their runs are running; only a
	// claiming run writes its own.
	const claims = claimsWithLockfilePorts(existingClaims);
	const others = otherClaims(claims, layout.claimKey);
	const conflictAt = (offset: number) =>
		findForeignConflict(
			probedPorts(layout.withExtras(layout.at(offset)), input.probeNames),
			{ root, projectName, runtime: runtimeName, getOwner },
		);
	const busy = (offset: number) => {
		const conflict = conflictAt(offset);
		return conflict
			? describePortConflict(conflict.port, conflict.owner, runtimeName, {
					root,
					projectPrefix: input.projectPrefix,
				})
			: undefined;
	};
	const { lockfile, own: ownLockfile, foreign } = readOwnLockfile(input);
	const settle = (
		offset: number,
		provenance: PortLockfile["provenance"],
	): PortPlan => {
		const ports = layout.at(offset);
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
				ports: layout.candidate(offset).ports,
				projectName,
				suffix,
				throwaway: input.throwaway,
			});
		return { offset, ports, provenance };
	};

	// The lockfile's offset, applied to whatever ports the config has now: an
	// added service keeps the block, and `{ "offset": 2500 }` alone pins it.
	let ignored = foreign;
	if (ownLockfile) {
		const choice = chooseBlock(
			[layout.candidate(ownLockfile.offset)],
			others,
			busy,
		);
		if ("offset" in choice) return settle(choice.offset, "lockfile");
		const [blocked] = choice.blocked;
		ignored = blocked?.problem;
		// A partial start must not move the block: the containers and apps it
		// did not select still publish the persisted ports.
		const partial =
			input.probeNames &&
			Object.keys(layout.basePorts).some(
				(name) => !input.probeNames?.includes(name),
			);
		const overflows = Object.values(
			layout.withExtras(layout.at(ownLockfile.offset)),
		).some((port) => port > 65535);
		if (blocked && partial && !overflows)
			throw new Error(
				`Selected app ports conflict with the persisted allocation: ${blocked.problem}. ${
					blocked.claimKeys.length > 0
						? "Start the full environment to move this checkout's shared port block."
						: "Stop that port's owner, or start the full environment to reconcile its shared port block."
				}`,
			);
	}

	// A suffixed environment has no lockfile; its own claim keeps its ports
	// from one run to the next, as a lockfile does for dev, and read-only
	// callers find the ports its last run used.
	const ownClaim = persist ? undefined : claims[layout.claimKey];
	if (ownClaim) {
		const choice = chooseBlock(
			[layout.candidate(ownClaim.offset)],
			others,
			busy,
		);
		if ("offset" in choice)
			return settle(choice.offset, layout.provenance(choice.offset));
	}

	const choice = chooseBlock(layout.search(), others, busy);
	if ("offset" in choice) {
		// Moving off a lockfile changes every URL of the checkout: say why.
		if (persist && lockfile && ignored && lockfile.offset !== choice.offset)
			console.warn(
				formatWarn(
					`.buncargo/ports.json (offset ${lockfile.offset}) not used: ${ignored}. Using offset ${choice.offset}.`,
				),
			);
		return settle(choice.offset, layout.provenance(choice.offset));
	}

	if (!claim)
		return {
			offset: layout.hashed,
			ports: layout.at(layout.hashed),
			provenance: "unallocated",
		};

	// Only now, with nothing free, does a claimed block pay for a probe: one a
	// process holds stays taken when its claim goes, so it is not worth
	// reclaiming.
	for (const block of choice.blocked)
		if (!block.unusable && conflictAt(block.offset)) block.unusable = true;
	throw new PortBlockExhaustedError({
		root,
		range: {
			min: PORT_OFFSET_MIN,
			max: layout.maxOffset,
			hashed: layout.hashed,
		},
		blocked: choice.blocked,
		claims,
		pinnable: pinnableOffsetAbove(layout.maxOffset, (offset) => {
			const block = layout.candidate(offset);
			return block.ports.some((port) => port > 65535)
				? "overflow"
				: offsetClaimConflict(others, block);
		}),
	});
}

/** The ports a probe looks at: all of them, or only the selected apps' and services'. */
function probedPorts(
	ports: Record<string, number>,
	probeNames: readonly string[] | undefined,
): Record<string, number> {
	return probeNames
		? Object.fromEntries(
				Object.entries(ports).filter(([name]) =>
					probeNames.includes(portOwnerName(name)),
				),
			)
		: ports;
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
	services: Readonly<Record<string, PortedService>>;
	apps?: Readonly<Record<string, PortedApp>>;
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
