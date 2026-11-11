import { remainingTime, withDeadline } from "../core/deadline";
import { isTcpPortOpen } from "../core/network";
import type {
	BuncargoContainer,
	ContainerRuntimeName,
	PortContainerOwner,
} from "../types";
import { isContainerLive, isContainerServing } from "./container-state";
import type {
	ContainerRuntimeAdapter,
	RuntimeContainer,
	ServiceDiagnosis,
	ServiceDiagnosisRequest,
	ServiceRuntimeState,
} from "./types";

/**
 * One reading of every container a runtime holds, and the answers derived
 * from it.
 *
 * A startup asks four questions of the runtime: is it up, which of this
 * project's services run and from which config, and which container holds
 * each port. Each used to be its own `docker ps` in its own format, so a warm
 * start forked the same listing three times inside the project lock. Each
 * backend now lists once into `RuntimeContainer` records, and
 * everything else is a projection of those records here.
 */

/** This project's service containers, as the startup and the watch read them. */
export function serviceStatesOf(
	containers: readonly RuntimeContainer[],
	projectName: string,
): ServiceRuntimeState[] {
	return containers.flatMap((container) => {
		const { project, service, serviceHash } = container.labels;
		if (project !== projectName || !service) return [];
		return [
			{
				service,
				state: container.state,
				serving: isContainerServing(container.state),
				...(serviceHash ? { serviceHash } : {}),
				...(container.healthy === undefined
					? {}
					: { healthy: container.healthy }),
				...(container.exitCode === undefined
					? {}
					: { exitCode: container.exitCode }),
			},
		];
	});
}

/** The container behind one of a project's services, if it has one. */
export function serviceContainerOf(
	containers: readonly RuntimeContainer[],
	projectName: string,
	service: string,
): RuntimeContainer | undefined {
	return containers.find(
		(container) =>
			container.labels.project === projectName &&
			container.labels.service === service,
	);
}

/**
 * Which container publishes each host port.
 *
 * Only a live container holds its ports: a paused or restarting one keeps or
 * takes them back, while Apple lists a stopped container's configured ports
 * too. The first container listed wins a port two claim.
 */
export function portOwnersOf(
	containers: readonly RuntimeContainer[],
	/** The runtime that listed them, recorded on each owner. */
	runtime?: ContainerRuntimeName,
): Map<number, PortContainerOwner> {
	const owners = new Map<number, PortContainerOwner>();
	for (const container of containers) {
		if (!isContainerLive(container.state)) continue;
		const owner: PortContainerOwner = {
			id: container.id,
			name: container.name,
			composeProject: container.labels.composeProject,
			root: container.labels.root,
			...(runtime ? { runtime } : {}),
		};
		for (const port of container.ports)
			if (!owners.has(port)) owners.set(port, owner);
	}
	return owners;
}

/** The containers buncargo created, as the inventory commands and the sweep read them. */
export function buncargoContainersOf(
	containers: readonly RuntimeContainer[],
	runtime: ContainerRuntimeName,
): BuncargoContainer[] {
	return containers.flatMap((container) => {
		const { project, root, worktree, service } = container.labels;
		if (!project) return [];
		return [
			{
				id: container.id,
				name: container.name,
				state: container.runtimeState,
				status: container.status,
				ports: container.portsText,
				project,
				root: root ?? "",
				worktree: worktree ?? "",
				service: service ?? "",
				runtime,
			},
		];
	});
}

/** `availability()` said up: the daemon answers. */
export function isRuntimeUp(
	runtime: Pick<ContainerRuntimeAdapter, "availability">,
): boolean {
	return runtime.availability().state === "up";
}

/**
 * State of every container the runtime has for the project, in one listing.
 * Throws when the runtime cannot answer: a startup reads that as
 * "reconcile", so a failure costs a redundant `up` rather than a skipped one.
 */
export async function projectServiceStates(
	runtime: Pick<ContainerRuntimeAdapter, "containers">,
	projectName: string,
	signal?: AbortSignal,
): Promise<ServiceRuntimeState[]> {
	return serviceStatesOf(await runtime.containers(signal), projectName);
}

/**
 * Every buncargo container the runtime holds. Throws when it cannot answer,
 * so a machine-wide reader tells "no containers" from "could not ask": the
 * sweep must never retire a record because a stopped daemon listed nothing.
 */
export async function buncargoContainersOn(
	runtime: Pick<ContainerRuntimeAdapter, "containers" | "name">,
	signal?: AbortSignal,
): Promise<BuncargoContainer[]> {
	return buncargoContainersOf(await runtime.containers(signal), runtime.name);
}

/**
 * Which container publishes each host port. A runtime that cannot answer
 * names no container; the port's process owner still does.
 */
export async function containerPortOwners(
	runtime: Pick<ContainerRuntimeAdapter, "containers" | "name">,
	signal?: AbortSignal,
): Promise<Map<number, PortContainerOwner>> {
	try {
		return portOwnersOf(await runtime.containers(signal), runtime.name);
	} catch {
		signal?.throwIfAborted();
		return new Map();
	}
}

const DEFAULT_LOG_TAIL = 20;

/**
 * State and recent output for one service, or undefined when the runtime has
 * no container for it or cannot answer. Never throws: this only enriches
 * diagnostics, and the state alone still fails a startup fast.
 */
export async function diagnoseService(
	runtime: Pick<ContainerRuntimeAdapter, "containers" | "logs">,
	request: ServiceDiagnosisRequest,
): Promise<ServiceDiagnosis | undefined> {
	const deadline = performance.now() + (request.timeoutMs ?? 2000);
	try {
		const container = serviceContainerOf(
			await withDeadline(
				(signal) => runtime.containers(signal),
				remainingTime(deadline),
				request.signal,
			),
			request.projectName,
			request.serviceName,
		);
		if (!container) return undefined;

		const state = {
			state: container.runtimeState,
			...(container.exitCode === undefined
				? {}
				: { exitCode: container.exitCode }),
		};
		if (remainingTime(deadline) === 0) return { ...state, logTail: "" };
		const logTail = await runtime.logs({
			id: container.id,
			tail: request.tail ?? DEFAULT_LOG_TAIL,
			root: request.root,
			signal: request.signal,
			timeoutMs: remainingTime(deadline),
		});
		return { ...state, logTail };
	} catch {
		return undefined;
	}
}

/** How long one connect to a container's own address may take. */
const CONTAINER_CONNECT_MS = 250;

/**
 * Whether the service listens on the container port behind `hostPort`, asked
 * of the container's own address: for a runtime whose published ports accept
 * before anything listens (`capabilities.hostPortProbe` false). The connect
 * is bounded short, since that address refuses or drops, to keep the poll
 * cadence. Never throws; false for anything but a listening service.
 */
export async function probeContainerPort(
	runtime: Pick<ContainerRuntimeAdapter, "containers">,
	request: {
		projectName: string;
		serviceName: string;
		hostPort: number;
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<boolean> {
	const deadline = performance.now() + request.timeoutMs;
	try {
		const container = serviceContainerOf(
			await withDeadline(
				(signal) => runtime.containers(signal),
				remainingTime(deadline),
				request.signal,
			),
			request.projectName,
			request.serviceName,
		);
		// Unanswered fails the probe, which the next poll asks again.
		if (!container?.address || !isContainerServing(container.state))
			return false;
		const containerPort =
			container.targetPorts?.[request.hostPort] ?? request.hostPort;
		return await isTcpPortOpen(
			containerPort,
			container.address,
			Math.min(CONTAINER_CONNECT_MS, remainingTime(deadline)),
			request.signal,
		);
	} catch {
		request.signal?.throwIfAborted();
		return false;
	}
}
