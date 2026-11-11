import { isDefined, isRecord, safeJsonParse, toArray } from "hanzio";
import {
	type ContainerState,
	isContainerServing,
	parseContainerState,
} from "../container-runtime/container-state";
import type {
	ContainerLogsRequest,
	RuntimeContainer,
} from "../container-runtime/types";
import { SERVICE_HASH_LABEL } from "../docker-compose/interpolate";
import type { AppleCliResult, AppleContainerCli } from "./cli";
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
		const ports = candidate.map(readPort).filter(isDefined);
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

/** `parseContainerRecords`, or undefined for output that is not JSON at all. */
function tryParseContainerRecords(
	stdout: string,
): AppleContainerRecord[] | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	const parsed = safeJsonParse(trimmed);
	if (!parsed.ok) return undefined;
	return toArray(parsed.data)
		.filter(isRecord)
		.flatMap((entry) => {
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

/** Records from `container ls --format json`; output that is not JSON reads as none. */
export function parseContainerRecords(stdout: string): AppleContainerRecord[] {
	return tryParseContainerRecords(stdout) ?? [];
}

/**
 * One `container ls --all`: what is there, or that it could not be asked.
 * Kept apart because callers act on the difference: "nothing there" lets the
 * watch report a removed container and `up` create one, while "could not
 * ask" must change nothing.
 */
export type AppleListing =
	| { listed: true; records: AppleContainerRecord[] }
	| { listed: false; error: string };

export const LIST_ARGS = ["ls", "--all", "--format", "json"];

export function readContainerListing(result: AppleCliResult): AppleListing {
	if (!result.ok)
		return {
			listed: false,
			error: result.stderr.trim() || `container ls exited ${result.exitCode}`,
		};
	const records = tryParseContainerRecords(result.stdout);
	if (!records)
		return { listed: false, error: "container ls printed something not JSON" };
	return { listed: true, records };
}

/** The records, or none where the runtime could not answer. */
function recordsOrNone(listing: AppleListing): AppleContainerRecord[] {
	return listing.listed ? listing.records : [];
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

/** The record's state in buncargo's words; see `container-state.ts`. */
export function recordState(record: AppleContainerRecord): ContainerState {
	return parseContainerState(record.state);
}

/** A record in buncargo's words, as every runtime-neutral reader takes it. */
function toRuntimeContainer(record: AppleContainerRecord): RuntimeContainer {
	const label = (name: string) => record.labels[name] || undefined;
	const labels = {
		// Apple has no Compose: its project label is the project both ways.
		composeProject: label(PROJECT_LABEL),
		project: label(PROJECT_LABEL),
		root: label("buncargo.root"),
		worktree: label("buncargo.worktree"),
		service: label(SERVICE_LABEL),
		serviceHash: label(SERVICE_HASH_LABEL),
	};
	const published = record.ports.flatMap((port) =>
		Array.from({ length: port.count ?? 1 }, (_, offset) => ({
			host: port.hostPort + offset,
			target:
				port.containerPort === undefined
					? undefined
					: port.containerPort + offset,
		})),
	);
	const targetPorts = published.flatMap(({ host, target }) =>
		target === undefined || target === host ? [] : [[host, target] as const],
	);
	return {
		id: record.id,
		name: record.id,
		state: recordState(record),
		runtimeState: record.state,
		status: record.state,
		ports: published.map(({ host }) => host),
		...(targetPorts.length > 0
			? { targetPorts: Object.fromEntries(targetPorts) }
			: {}),
		...(record.address ? { address: record.address } : {}),
		portsText: formatPublishedPorts(record.ports),
		labels: Object.fromEntries(
			Object.entries(labels).filter(([, value]) => value !== undefined),
		),
	};
}

/** Every container, in one `container ls`. Throws when the runtime cannot answer. */
export async function appleContainers(
	cli: AppleContainerCli,
	signal?: AbortSignal,
): Promise<RuntimeContainer[]> {
	const listing = await listContainerRecordsAsync(cli, signal);
	if (!listing.listed) throw new Error(listing.error);
	return listing.records.map(toRuntimeContainer);
}

async function listContainerRecordsAsync(
	cli: AppleContainerCli,
	signal?: AbortSignal,
	timeoutMs = 10000,
): Promise<AppleListing> {
	return readContainerListing(
		await runAppleAsync(cli, LIST_ARGS, { signal, timeoutMs }),
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
	const listing = await listContainerRecordsAsync(cli, signal);
	const record = recordsOrNone(listing).find(
		(candidate) => candidate.id === name,
	);
	return record !== undefined && isContainerServing(recordState(record));
}

/** `container logs` of one container, or empty when Apple won't say. */
export async function appleContainerLogs(
	cli: AppleContainerCli,
	request: ContainerLogsRequest,
): Promise<string> {
	try {
		const logs = await runAppleAsync(
			cli,
			["logs", "-n", String(request.tail), request.id],
			{ signal: request.signal, timeoutMs: request.timeoutMs },
		);
		return logs.ok ? logs.stdout.trim() : "";
	} catch {
		return "";
	}
}
