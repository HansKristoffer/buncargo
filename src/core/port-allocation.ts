import { join } from "node:path";
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
	offsetClaimedBy,
	readOffsetClaims,
} from "./offset-claims";
import type { PortMap } from "./ports";
import {
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
export const PORT_OFFSET_MIN = 100;
export const PORT_OFFSET_MAX = 9000;
export const PORTS_LOCKFILE = `${STATE_DIRNAME}/ports.json`;
const LOCKFILE_VERSION = 1;
const PORT_ALLOCATION_ATTEMPTS = 80;

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
	provenance: Exclude<PortOffsetProvenance, "env">;
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
	const buckets = (PORT_OFFSET_MAX - PORT_OFFSET_MIN) / PORT_OFFSET_STEP + 1;
	const bucket = simpleHash(parts.join(":")) % buckets;
	return PORT_OFFSET_MIN + bucket * PORT_OFFSET_STEP;
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

/** Ports an allocation can inspect, for one scoped asynchronous cwd reading. */
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
	const baseOffset = computeBaseOffset(input);
	const offsets = new Set([
		currentOffset,
		...Array.from(
			{ length: PORT_ALLOCATION_ATTEMPTS },
			(_, index) => baseOffset + index * PORT_OFFSET_STEP,
		),
	]);
	return Object.entries(buildPortMap(input.services, input.apps))
		.filter(([name]) => !input.probeNames || input.probeNames.includes(name))
		.flatMap(([, base]) => [...offsets].map((offset) => base + offset))
		.filter((port) => port > 0 && port <= 65535);
}

function shiftPorts(
	basePorts: Record<string, number>,
	offset: number,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(basePorts).map(([name, port]) => [name, port + offset]),
	);
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
function foreignLockfile(
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

export function describePortConflict(
	port: number,
	owner: PortOwner | null,
): string {
	if (!owner) return `port ${port} is in use`;
	return formatPortOwner(port, owner);
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
	persist?: boolean;
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
}): PortPlan {
	const {
		projectPrefix,
		projectName,
		root,
		services,
		apps,
		suffix,
		worktreeName = null,
		worktreeIsolation = true,
		persist = true,
		runtime,
		probeConflicts = true,
	} = input;
	const runtimeName = runtime?.name;
	const basePorts = buildPortMap(services, apps);
	for (const [name, port] of Object.entries(basePorts))
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error(
				`Invalid base port for ${name}: ${port}. Expected an integer in 1..65535.`,
			);

	const envOffset = portOffsetOverride();
	if (envOffset !== undefined) {
		const ports = shiftPorts(basePorts, envOffset);
		for (const [name, port] of Object.entries(ports))
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

	// One reading of the machine for every port this allocator may look at,
	// including the shifted blocks it can fall through to. Probing per port cost
	// an `lsof` and a `docker ps` each, and the allocator is the first thing a
	// dev run does.
	//
	// Reporting no owner is what makes every conflict check below pass, so a
	// read-only caller gets the lockfile back rather than a block reallocated
	// around its own running services.
	const lookupOwner = probeConflicts
		? (input.getOwner ?? withBindProbe(snapshotOwnerLookup(basePorts, runtime)))
		: () => null;

	const probed = (ports: Record<string, number>) =>
		input.probeNames
			? Object.fromEntries(
					Object.entries(ports).filter(([name]) =>
						input.probeNames?.includes(name),
					),
				)
			: ports;
	const lockfile = readPortsLockfile(root);
	const notOurs = lockfile && foreignLockfile(lockfile, { projectName, root });
	const ownLockfile = lockfile && !notOurs ? lockfile : undefined;
	if (!probeConflicts && ownLockfile) {
		// A config edit must not make a maintenance command switch away from
		// the endpoints the last startup published. New keys use the same offset.
		const ports = Object.fromEntries(
			Object.entries(basePorts).map(([name, base]) => [
				name,
				ownLockfile.ports[name] ?? base + ownLockfile.offset,
			]),
		);
		if (Object.values(ports).some((port) => port > 65535))
			throw new Error(
				"Persisted offset cannot accommodate this config; run dev to reconcile the allocation.",
			);
		return { offset: ownLockfile.offset, ports, provenance: "lockfile" };
	}

	// Other checkouts' offsets are skipped whether or not they are running;
	// only a run that persists its allocation claims one.
	const claims = readOffsetClaims();
	const claimant = (offset: number) => offsetClaimedBy(claims, offset, root);
	const conflictAt = (ports: Record<string, number>) =>
		findForeignConflict(probed(ports), {
			root,
			projectName,
			runtime: runtimeName,
			getOwner: lookupOwner,
		});
	const settle = (
		offset: number,
		ports: Record<string, number>,
		provenance: PortOffsetProvenance,
	): PortPlan => {
		if (persist) {
			const next: PortLockfile = {
				version: LOCKFILE_VERSION,
				projectName,
				root,
				offset,
				ports,
				provenance: provenance === "env" ? "lockfile" : provenance,
			};
			if (JSON.stringify(next) !== JSON.stringify(lockfile))
				writePortsLockfile(root, next);
			claimOffset(root, offset, projectName);
		}
		return { offset, ports, provenance };
	};

	// The lockfile's offset, applied to whatever ports the config has now: an
	// added service keeps the block, and `{ "offset": 2500 }` alone pins it.
	let ignored = notOurs;
	if (ownLockfile) {
		const ports = shiftPorts(basePorts, ownLockfile.offset);
		const holder = claimant(ownLockfile.offset);
		if (holder)
			ignored = `offset ${ownLockfile.offset} is claimed by ${holder}`;
		else if (Object.values(ports).some((port) => port > 65535))
			ignored = `offset ${ownLockfile.offset} puts a port above 65535`;
		else {
			const conflict = conflictAt(ports);
			if (!conflict) return settle(ownLockfile.offset, ports, "lockfile");
			if (
				input.probeNames &&
				Object.keys(basePorts).some((name) => !input.probeNames?.includes(name))
			) {
				throw new Error(
					"Selected app ports conflict with the persisted allocation. Stop the conflicting port owner, or start the full environment to reconcile its shared port block.",
				);
			}
			ignored = describePortConflict(conflict.port, conflict.owner);
		}
	}
	const settleAllocated = (
		offset: number,
		ports: Record<string, number>,
		provenance: PortOffsetProvenance,
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

	let offset = computeBaseOffset({
		projectPrefix,
		worktreeName,
		suffix,
		worktreeIsolation,
	});
	let provenance: PortOffsetProvenance = "hash";

	for (let attempt = 0; attempt < PORT_ALLOCATION_ATTEMPTS; attempt++) {
		const ports = shiftPorts(basePorts, offset);
		const overflow = Object.values(ports).some((port) => port > 65535);
		if (!overflow && !claimant(offset) && !conflictAt(ports))
			return settleAllocated(
				offset,
				ports,
				provenance === "hash" ? "hash" : "shifted",
			);
		offset += PORT_OFFSET_STEP;
		provenance = "shifted";
		if (offset > PORT_OFFSET_MAX + PORT_OFFSET_STEP * 20) {
			break;
		}
	}

	const failedPorts = shiftPorts(basePorts, offset);
	const conflict = findForeignConflict(probed(failedPorts), {
		root,
		projectName,
		runtime: runtimeName,
		getOwner: lookupOwner,
	});
	throw new Error(
		conflict
			? `Could not allocate a free port block. ${describePortConflict(conflict.port, conflict.owner)}.`
			: "Could not allocate a free port block.",
	);
}
