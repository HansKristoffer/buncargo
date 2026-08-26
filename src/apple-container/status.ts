import type {
	ServiceDiagnosis,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import type { BuncargoContainer, PortContainerOwner } from "../types";
import type { AppleContainerCli } from "./cli";
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
}

export interface PublishedPort {
	hostAddress?: string;
	hostPort: number;
	containerPort?: number;
	protocol?: string;
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
	return {
		hostAddress: readString(entry.hostAddress ?? entry.host_address),
		hostPort,
		containerPort: Number.isFinite(containerPort) ? containerPort : undefined,
		protocol: readString(entry.protocol),
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
		return [
			{
				id,
				state: readState(entry),
				labels: readLabels(entry),
				ports: readPorts(entry),
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
		status: record.state,
		ports: formatPublishedPorts(record.ports),
		project: record.labels[PROJECT_LABEL] ?? "",
		root: record.labels["buncargo.root"] ?? "",
		worktree: record.labels["buncargo.worktree"] ?? "",
		service: record.labels[SERVICE_LABEL] ?? "",
		runtime: "apple",
	};
}

export function listAppleBuncargoContainers(
	cli: AppleContainerCli,
): BuncargoContainer[] {
	return listContainerRecords(cli)
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

export function areAppleServicesRunning(
	cli: AppleContainerCli,
	projectName: string,
	serviceNames: string[],
): boolean {
	if (serviceNames.length === 0) return false;
	const running = new Set(
		projectRecords(cli, projectName)
			.filter((record) => isRunningState(record.state))
			.map((record) => record.labels[SERVICE_LABEL]),
	);
	return serviceNames.every((name) => running.has(name));
}

/**
 * State and recent output for one service.
 *
 * The state comes from the same `container ls --all` read every other question
 * here uses; the log tail is a best effort on top, because a runtime that
 * cannot produce it should still fail fast on the state alone.
 */
export function diagnoseAppleService(
	cli: AppleContainerCli,
	request: ServiceDiagnosisRequest,
): ServiceDiagnosis | undefined {
	const containerName = containerNameFor(
		request.projectName,
		request.serviceName,
	);
	const record = listContainerRecords(cli).find(
		(candidate) => candidate.id === containerName,
	);
	if (!record) return undefined;

	const logs = cli.run([
		"logs",
		"-n",
		String(request.tail ?? 20),
		containerName,
	]);

	return {
		state: record.state,
		logTail: logs.ok ? logs.stdout.trim() : "",
	};
}

export function findAppleContainerOnPort(
	cli: AppleContainerCli,
	port: number,
): PortContainerOwner | undefined {
	for (const record of listContainerRecords(cli)) {
		if (!isRunningState(record.state)) continue;
		if (!record.ports.some((published) => published.hostPort === port)) {
			continue;
		}
		return {
			id: record.id,
			name: record.id,
			composeProject: record.labels[PROJECT_LABEL] || undefined,
		};
	}
	return undefined;
}
