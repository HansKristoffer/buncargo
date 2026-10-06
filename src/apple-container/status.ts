import type {
	ServiceDiagnosis,
	ServiceDiagnosisRequest,
	ServicePortProbeRequest,
	ServiceRuntimeState,
} from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import { isTcpPortOpen } from "../core/network";
import { SERVICE_HASH_LABEL } from "../docker-compose/interpolate";
import type { BuncargoContainer, PortContainerOwner } from "../types";
import type { AppleContainerCli } from "./cli";
import { runAppleAsync } from "./cli";
import { containerNameFor, PROJECT_LABEL, SERVICE_LABEL } from "./run-plan";

/**
 * Reading Apple `container` inventory.
 *
 * `container ls` has no `--filter`, so every scoped question is answered by
 * listing once and filtering here. The JSON shape has moved between releases,
 * so each field is read defensively from the places it has been known to live
 * rather than against a fixed schema.
 */

export interface AppleContainerRecord {
	id: string;
	state: string;
	labels: Record<string, string>;
	ports: PublishedPort[];
	/** The container's IPv4 address on Apple's network, while it runs. */
	address?: string;
}

export interface PublishedPort {
	hostAddress?: string;
	hostPort: number;
	containerPort?: number;
	protocol?: string;
	/** Consecutive ports from `hostPort` a range publishes. Default 1. */
	count?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readLabels(source: Record<string, unknown>): Record<string, string> {
	const configuration = isRecord(source.configuration)
		? source.configuration
		: undefined;
	const raw = configuration?.labels ?? source.labels;
	if (!isRecord(raw)) return {};
	const labels: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") labels[key] = value;
	}
	return labels;
}

function readId(source: Record<string, unknown>): string | undefined {
	const configuration = isRecord(source.configuration)
		? source.configuration
		: undefined;
	return (
		readString(configuration?.id) ??
		readString(source.id) ??
		readString(configuration?.hostname)
	);
}

function readState(source: Record<string, unknown>): string {
	const status = source.status;
	if (typeof status === "string") return status;
	if (isRecord(status)) return readString(status.state) ?? "unknown";
	return readString(source.state) ?? "unknown";
}

function readPort(entry: unknown): PublishedPort | null {
	if (typeof entry === "string") {
		// "0.0.0.0:5433:5432/tcp" or "5433:5432"
		const [spec, protocol] = entry.split("/");
		const parts = (spec ?? "").split(":");
		const containerPort = Number.parseInt(parts.at(-1) ?? "", 10);
		const hostPort = Number.parseInt(parts.at(-2) ?? "", 10);
		if (!Number.isFinite(hostPort)) return null;
		return {
			hostAddress: parts.length > 2 ? parts[0] : undefined,
			hostPort,
			containerPort: Number.isFinite(containerPort) ? containerPort : undefined,
			protocol,
		};
	}
	if (!isRecord(entry)) return null;
	const hostPort = Number(entry.hostPort ?? entry.host_port ?? entry.host);
	if (!Number.isFinite(hostPort)) return null;
	const containerPort = Number(
		entry.containerPort ?? entry.container_port ?? entry.container,
	);
	const count = Number(entry.count);
	return {
		hostAddress: readString(entry.hostAddress ?? entry.host_address),
		hostPort,
		containerPort: Number.isFinite(containerPort) ? containerPort : undefined,
		protocol: readString(entry.protocol ?? entry.proto),
		...(Number.isInteger(count) && count > 1 ? { count } : {}),
	};
}

function readPorts(source: Record<string, unknown>): PublishedPort[] {
	const configuration = isRecord(source.configuration)
		? source.configuration
		: undefined;
	const candidates = [
		configuration?.publishedPorts,
		configuration?.published_ports,
		configuration?.ports,
		source.publishedPorts,
		source.ports,
	];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;
		const ports = candidate
			.map(readPort)
			.filter((port): port is PublishedPort => port !== null);
		if (ports.length > 0) return ports;
	}
	return [];
}

function readAddress(source: Record<string, unknown>): string | undefined {
	const status = isRecord(source.status) ? source.status : undefined;
	const networks = Array.isArray(status?.networks) ? status.networks : [];
	for (const network of networks) {
		if (!isRecord(network)) continue;
		// "192.168.64.5/24"
		const address = readString(network.ipv4Address ?? network.address);
		if (address) return address.split("/")[0];
	}
	return undefined;
}

export function parseContainerRecords(stdout: string): AppleContainerRecord[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	return entries.filter(isRecord).flatMap((entry) => {
		const id = readId(entry);
		if (!id) return [];
		const address = readAddress(entry);
		return [
			{
				id,
				state: readState(entry),
				labels: readLabels(entry),
				ports: readPorts(entry),
				...(address ? { address } : {}),
			},
		];
	});
}

export function formatPublishedPorts(ports: PublishedPort[]): string {
	return ports
		.map((port) => {
			const address = port.hostAddress ?? "0.0.0.0";
			const target = port.containerPort ?? port.hostPort;
			const protocol = port.protocol ?? "tcp";
			return `${address}:${port.hostPort}->${target}/${protocol}`;
		})
		.join(", ");
}

export function isRunningState(state: string): boolean {
	return state.toLowerCase() === "running";
}

export function listContainerRecords(
	cli: AppleContainerCli,
): AppleContainerRecord[] {
	const result = cli.run(["ls", "--all", "--format", "json"]);
	if (!result.ok) return [];
	return parseContainerRecords(result.stdout);
}

export function toBuncargoContainer(
	record: AppleContainerRecord,
): BuncargoContainer {
	return {
		id: record.id,
		name: record.id,
		state: record.state,
		status: record.state,
		ports: formatPublishedPorts(record.ports),
		project: record.labels[PROJECT_LABEL] ?? "",
		root: record.labels["buncargo.root"] ?? "",
		worktree: record.labels["buncargo.worktree"] ?? "",
		service: record.labels[SERVICE_LABEL] ?? "",
		runtime: "apple",
	};
}

/**
 * Every buncargo container, or a throw when the runtime cannot answer.
 *
 * Throws rather than returning nothing, the way the Docker listing does, so a
 * machine-wide reader can tell "no containers" from "could not ask" — the
 * sweep must never retire a record because a stopped daemon listed nothing.
 */
export function listAppleBuncargoContainers(
	cli: AppleContainerCli,
): BuncargoContainer[] {
	const result = cli.run(["ls", "--all", "--format", "json"]);
	if (!result.ok)
		throw new Error(result.stderr.trim() || "container ls failed");
	return parseContainerRecords(result.stdout)
		.filter((record) => record.labels[PROJECT_LABEL])
		.map(toBuncargoContainer);
}

export function projectRecords(
	cli: AppleContainerCli,
	projectName: string,
): AppleContainerRecord[] {
	return listContainerRecords(cli).filter(
		(record) => record.labels[PROJECT_LABEL] === projectName,
	);
}

/**
 * Which container is publishing each host port, from one `container ls`.
 *
 * A map rather than a per-port scan for the same reason as the Docker backend:
 * a dev run asks about every service and app port, and one listing answers all
 * of them.
 */
export function appleContainerPortOwners(
	cli: AppleContainerCli,
): Map<number, PortContainerOwner> {
	return portOwnersFromRecords(listContainerRecords(cli));
}

export async function appleContainerPortOwnersAsync(
	cli: AppleContainerCli,
	signal?: AbortSignal,
): Promise<Map<number, PortContainerOwner>> {
	return portOwnersFromRecords(await listContainerRecordsAsync(cli, signal));
}

function portOwnersFromRecords(
	records: AppleContainerRecord[],
): Map<number, PortContainerOwner> {
	const owners = new Map<number, PortContainerOwner>();
	for (const record of records) {
		if (!isRunningState(record.state)) continue;
		const owner: PortContainerOwner = {
			id: record.id,
			name: record.id,
			composeProject: record.labels[PROJECT_LABEL] || undefined,
		};
		for (const published of record.ports) {
			for (let offset = 0; offset < (published.count ?? 1); offset++) {
				const port = published.hostPort + offset;
				if (!owners.has(port)) owners.set(port, owner);
			}
		}
	}
	return owners;
}

export function findAppleContainerOnPort(
	cli: AppleContainerCli,
	port: number,
): PortContainerOwner | undefined {
	return appleContainerPortOwners(cli).get(port);
}

export async function listContainerRecordsAsync(
	cli: AppleContainerCli,
	signal?: AbortSignal,
	timeoutMs = 10000,
): Promise<AppleContainerRecord[]> {
	const result = await runAppleAsync(cli, ["ls", "--all", "--format", "json"], {
		signal,
		timeoutMs,
	});
	return result.ok ? parseContainerRecords(result.stdout) : [];
}

/** Every container this project has, from one `container ls`. */
export async function appleProjectServiceStates(
	cli: AppleContainerCli,
	projectName: string,
	signal?: AbortSignal,
): Promise<ServiceRuntimeState[]> {
	const records = await listContainerRecordsAsync(cli, signal);
	return records
		.filter((record) => record.labels[PROJECT_LABEL] === projectName)
		.flatMap((record) => {
			const service = record.labels[SERVICE_LABEL];
			if (!service) return [];
			const serviceHash = record.labels[SERVICE_HASH_LABEL];
			return [
				{
					service,
					running: isRunningState(record.state),
					...(serviceHash ? { serviceHash } : {}),
				},
			];
		});
}

/**
 * State and recent output for one service.
 *
 * The state comes from the same `container ls --all` read every other question
 * here uses; the log tail is a best effort on top, because a runtime that
 * cannot produce it should still fail fast on the state alone.
 */
export async function diagnoseAppleService(
	cli: AppleContainerCli,
	request: ServiceDiagnosisRequest,
): Promise<ServiceDiagnosis | undefined> {
	const deadline = performance.now() + (request.timeoutMs ?? 2000);
	try {
		const name = containerNameFor(request.projectName, request.serviceName);
		const record = (
			await listContainerRecordsAsync(
				cli,
				request.signal,
				remainingTime(deadline),
			)
		).find((candidate) => candidate.id === name);
		if (!record) return undefined;
		if (remainingTime(deadline) === 0)
			return { state: record.state, logTail: "" };
		const logs = await runAppleAsync(
			cli,
			["logs", "-n", String(request.tail ?? 20), name],
			{ signal: request.signal, timeoutMs: remainingTime(deadline) },
		);
		return { state: record.state, logTail: logs.ok ? logs.stdout.trim() : "" };
	} catch {
		return undefined;
	}
}

/**
 * Whether the service listens on the container port behind `hostPort`.
 *
 * Asked of the container's own address because the host side cannot answer:
 * Apple's port forwarder accepts a connection on the published port whether or
 * not anything listens inside, so a host-side connect passes the moment the VM
 * boots. The container address refuses or drops instead, so the connect is
 * bounded short to keep the poll cadence.
 */
export async function probeAppleServicePort(
	cli: AppleContainerCli,
	request: ServicePortProbeRequest,
): Promise<boolean> {
	const deadline = performance.now() + (request.timeoutMs ?? 1000);
	const name = containerNameFor(request.projectName, request.serviceName);
	const record = (
		await listContainerRecordsAsync(
			cli,
			request.signal,
			remainingTime(deadline),
		)
	).find((candidate) => candidate.id === name);
	if (!record?.address || !isRunningState(record.state)) return false;
	const published = record.ports.find(
		(port) =>
			request.hostPort >= port.hostPort &&
			request.hostPort < port.hostPort + (port.count ?? 1),
	);
	const containerPort =
		published?.containerPort === undefined
			? request.hostPort
			: published.containerPort + (request.hostPort - published.hostPort);
	return isTcpPortOpen(
		containerPort,
		record.address,
		Math.min(250, remainingTime(deadline)),
		request.signal,
	);
}

/** Whether the service's container is running, for an interactive exec. */
export async function isAppleServiceRunning(
	cli: AppleContainerCli,
	projectName: string,
	serviceName: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const name = containerNameFor(projectName, serviceName);
	const record = (await listContainerRecordsAsync(cli, signal)).find(
		(candidate) => candidate.id === name,
	);
	return record !== undefined && isRunningState(record.state);
}
