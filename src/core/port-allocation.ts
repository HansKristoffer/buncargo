import { join } from "node:path";
import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import type {
	AppConfig,
	ContainerRuntimeName,
	PortOffsetProvenance,
	ServiceConfig,
} from "../types";
import { simpleHash } from "./hash";
import type { PortMap } from "./ports";
import {
	classifyPortOccupant,
	createPortOwnerSnapshot,
	formatPortOwner,
	type PortOwner,
} from "./process";
import { readJsonDocumentSync, writeJsonDocumentSync } from "./registry-file";
import { portOffsetOverride } from "./runtime-flags";
import { STATE_DIRNAME } from "./state-paths";

export const PORT_OFFSET_STEP = 100;
export const PORT_OFFSET_MIN = 100;
export const PORT_OFFSET_MAX = 9000;
export const PORTS_LOCKFILE = `${STATE_DIRNAME}/ports.json`;
const LOCKFILE_VERSION = 1;

export interface PortLockfile {
	version: number;
	projectName: string;
	root: string;
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
		ports[name] = config.port + offset;
		if (config.secondaryPort) {
			ports[`${name}Secondary`] = config.secondaryPort + offset;
		}
	}
	if (apps) {
		for (const [name, config] of Object.entries(apps)) {
			ports[name] = config.port + offset;
		}
	}
	return ports;
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
	if (lockfile.version !== LOCKFILE_VERSION) return undefined;
	if (typeof lockfile.offset !== "number") return undefined;
	if (typeof lockfile.projectName !== "string") return undefined;
	if (typeof lockfile.root !== "string") return undefined;
	if (typeof lockfile.ports !== "object" || lockfile.ports === null) {
		return undefined;
	}
	if (Object.values(lockfile.ports).some((port) => typeof port !== "number")) {
		return undefined;
	}
	const provenance = lockfile.provenance;
	if (
		provenance !== "hash" &&
		provenance !== "lockfile" &&
		provenance !== "shifted"
	) {
		return undefined;
	}
	return lockfile as PortLockfile;
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

function lockfileMatches(
	lockfile: PortLockfile,
	input: {
		projectName: string;
		root: string;
		basePorts: Record<string, number>;
	},
): boolean {
	if (lockfile.projectName !== input.projectName) return false;
	if (lockfile.root !== input.root) return false;
	const expectedKeys = Object.keys(input.basePorts);
	if (expectedKeys.length !== Object.keys(lockfile.ports).length) return false;
	return expectedKeys.every(
		(key) => lockfile.ports[key] === input.basePorts[key] + lockfile.offset,
	);
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
	// One reading of the machine for every port this allocator may look at,
	// including the shifted blocks it can fall through to. Probing per port cost
	// an `lsof` and a `docker ps` each, and the allocator is the first thing a
	// dev run does.
	//
	// Reporting no owner is what makes every conflict check below pass, so a
	// read-only caller gets the lockfile back rather than a block reallocated
	// around its own running services.
	const lookupOwner = probeConflicts
		? (input.getOwner ?? snapshotOwnerLookup(basePorts, runtime))
		: () => null;

	const envOffset = portOffsetOverride();
	if (envOffset !== undefined) {
		return {
			offset: envOffset,
			ports: shiftPorts(basePorts, envOffset),
			provenance: "env",
		};
	}

	const lockfile = readPortsLockfile(root);
	if (lockfile && lockfileMatches(lockfile, { projectName, root, basePorts })) {
		const conflict = findForeignConflict(lockfile.ports, {
			root,
			projectName,
			runtime: runtimeName,
			getOwner: lookupOwner,
		});
		if (!conflict) {
			return {
				offset: lockfile.offset,
				ports: lockfile.ports,
				provenance: "lockfile",
			};
		}
	}

	let offset = computeBaseOffset({
		projectPrefix,
		worktreeName,
		suffix,
		worktreeIsolation,
	});
	let provenance: PortOffsetProvenance = "hash";

	for (let attempt = 0; attempt < 80; attempt++) {
		const ports = shiftPorts(basePorts, offset);
		const overflow = Object.values(ports).some((port) => port > 65535);
		if (!overflow) {
			const conflict = findForeignConflict(ports, {
				root,
				projectName,
				runtime: runtimeName,
				getOwner: lookupOwner,
			});
			if (!conflict) {
				if (persist) {
					writePortsLockfile(root, {
						version: LOCKFILE_VERSION,
						projectName,
						root,
						offset,
						ports,
						provenance: provenance === "hash" ? "hash" : "shifted",
					});
				}
				return { offset, ports, provenance };
			}
		}
		offset += PORT_OFFSET_STEP;
		provenance = "shifted";
		if (offset > PORT_OFFSET_MAX + PORT_OFFSET_STEP * 20) {
			break;
		}
	}

	const failedPorts = shiftPorts(basePorts, offset);
	const conflict = findForeignConflict(failedPorts, {
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
