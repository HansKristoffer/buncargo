import { isRecord } from "hanzio";
import type {
	ComposeDocument,
	ComposeIdentity,
	ContainerRuntimeName,
	DockerComposeGenerationOptions,
	DockerComposeNode,
	DockerComposeServiceRaw,
	DockerComposeVolumeRaw,
	ResolvedComposeService,
	ResolvedService,
	SuffixedEnvironmentOptions,
} from "../types";
import {
	normalizeComposeLabels,
	SERVICE_HASH_LABEL,
	serviceHashEnv,
} from "./interpolate";
import { presetDefinition } from "./services";
import { getDefaultPortBindings, portBindings } from "./services/shared";

export type { ComposeDocument, ComposeIdentity };

function deepMergeNode(
	base: DockerComposeNode,
	override: DockerComposeNode,
): DockerComposeNode {
	if (Array.isArray(base) || Array.isArray(override)) {
		return override;
	}
	if (!isRecord(base) || !isRecord(override)) {
		return override;
	}

	const merged: Record<string, DockerComposeNode | undefined> = { ...base };
	for (const key of Object.keys(override)) {
		const baseValue = merged[key];
		const overrideValue = override[key];
		if (baseValue === undefined || overrideValue === undefined) {
			merged[key] = overrideValue;
		} else {
			merged[key] = deepMergeNode(baseValue, overrideValue);
		}
	}
	return merged;
}

function resolveServiceDefinition(
	name: string,
	config: ResolvedComposeService,
	runtime?: ContainerRuntimeName,
): {
	service: DockerComposeServiceRaw;
	volume?: string;
} {
	const { docker } = config;
	if (docker.kind === "raw") {
		const service = { ...docker.service };
		if (!service.ports || service.ports.length === 0)
			service.ports = getDefaultPortBindings(name, config);
		return { service };
	}

	const { service, volume } = presetDefinition(docker.preset).build({
		serviceKey: name,
		config,
		runtime,
	});
	const merged = docker.override
		? (deepMergeNode(
				service as DockerComposeNode,
				docker.override as DockerComposeNode,
			) as DockerComposeServiceRaw)
		: service;
	return { service: merged, volume };
}

export interface ComposeModelOptions {
	/** `"tmpfs"` also declares none of the volumes it no longer mounts. */
	data?: SuffixedEnvironmentOptions["data"];
	/**
	 * `"assigned"` publishes each port buncargo generates on a host port the
	 * runtime picks (`127.0.0.1::5432`), read back after `up` with
	 * {@link assignedPortTargets}. A port the config spells out stays.
	 */
	ports?: "claimed" | "assigned";
}

/** Where a port key's assigned host port is read back from. */
export interface AssignedPortTarget {
	/** The Compose service name. */
	service: string;
	containerPort: number;
}

function presetOf(config: ResolvedComposeService) {
	return config.docker.kind === "preset" ? config.docker.preset : undefined;
}

/** The service with each generated port binding on a runtime-assigned host port. */
function withAssignedPorts(
	service: DockerComposeServiceRaw,
	name: string,
	config: ResolvedComposeService,
): DockerComposeServiceRaw {
	const bindings = portBindings(name, config, presetOf(config));
	if (!service.ports || bindings.length === 0) return service;
	const assigned = new Map(bindings.map((b) => [b.claimed, b.assigned]));
	return {
		...service,
		ports: service.ports.map((entry) => assigned.get(entry) ?? entry),
	};
}

/**
 * Each port key the model publishes on a runtime-assigned host port: the
 * ports `ports: "assigned"` rewrote, and no other.
 */
export function assignedPortTargets(
	services: Readonly<Record<string, ResolvedService>>,
	model: ComposeDocument,
): Record<string, AssignedPortTarget> {
	const targets: Record<string, AssignedPortTarget> = {};
	for (const [name, config] of Object.entries(services)) {
		if (config.kind === "external") continue;
		const published = model.services[config.serviceName]?.ports ?? [];
		for (const binding of portBindings(name, config, presetOf(config)))
			if (published.includes(binding.assigned))
				targets[binding.portKey] = {
					service: config.serviceName,
					containerPort: binding.containerPort,
				};
	}
	return targets;
}

/** A short-syntax source that names a host path rather than a volume. */
function isBindSource(source: string): boolean {
	return /^[./~$]/.test(source);
}

/** The service with each mount of a volume not in `kept` moved to tmpfs. */
function withDataInMemory(
	service: DockerComposeServiceRaw,
	kept: ReadonlySet<string>,
): DockerComposeServiceRaw {
	// Typed as strings, but a raw service can use Compose's long syntax.
	const mounts: DockerComposeNode[] = service.volumes ?? [];
	if (mounts.length === 0) return service;
	const volumes: DockerComposeNode[] = [];
	const tmpfs: string[] =
		service.tmpfs === undefined
			? []
			: Array.isArray(service.tmpfs)
				? service.tmpfs.map(String)
				: [String(service.tmpfs)];
	for (const mount of mounts) {
		if (isRecord(mount)) {
			const type = mount.type ?? "volume";
			const source = typeof mount.source === "string" ? mount.source : "";
			if (type === "volume" && !kept.has(source))
				tmpfs.push(String(mount.target));
			else volumes.push(mount);
			continue;
		}
		const [source = "", target] = String(mount).split(":");
		// No target: an anonymous volume, mounted at the source position.
		if (target === undefined) tmpfs.push(source);
		else if (isBindSource(source) || kept.has(source)) volumes.push(mount);
		else tmpfs.push(target);
	}
	const inMemory: DockerComposeServiceRaw = { ...service, tmpfs };
	if (volumes.length > 0) inMemory.volumes = volumes as string[];
	else delete inMemory.volumes;
	return inMemory;
}

/**
 * @param runtime The *resolved* backend, not the configured selection. A preset
 * needs to know which of the two will actually run it, and `docker.runtime` may
 * still say `"auto"` at this point.
 */
export function buildComposeModel(
	services: Readonly<Record<string, ResolvedService>>,
	docker?: DockerComposeGenerationOptions,
	identity?: ComposeIdentity,
	runtime?: ContainerRuntimeName,
	options: ComposeModelOptions = {},
): ComposeDocument {
	const inMemory = options.data === "tmpfs";
	// Volumes another project or the user owns: never this stack's to replace.
	const external = new Set(
		Object.entries(docker?.volumes ?? {})
			.filter(([, volume]) => Boolean(volume.external))
			.map(([name]) => name),
	);
	const composeServices: Record<string, DockerComposeServiceRaw> = {};
	const composeVolumes: Record<string, DockerComposeVolumeRaw> = {};

	for (const [name, serviceConfig] of Object.entries(services)) {
		// Its stack's own CLI creates it; buncargo only knows its port.
		if (serviceConfig.kind === "external") continue;
		const resolved = resolveServiceDefinition(name, serviceConfig, runtime);
		const { serviceName } = serviceConfig;
		const { volume } = resolved;
		const stored = inMemory
			? withDataInMemory(resolved.service, external)
			: resolved.service;
		const service =
			options.ports === "assigned"
				? withAssignedPorts(stored, name, serviceConfig)
				: stored;
		if (identity) {
			const identityLabels = {
				"buncargo.project": identity.projectName,
				"buncargo.root": identity.root,
				"buncargo.worktree": identity.worktree ?? "",
				"buncargo.service": serviceName,
				// Stable across selected subsets; the backend receives the interpolated hash.
				[SERVICE_HASH_LABEL]: `\${${serviceHashEnv(serviceName)}:-}`,
			};
			// Preserve list syntax: Compose interpolates list-form label keys, but
			// deliberately does not interpolate keys in mapping syntax.
			service.labels = Array.isArray(service.labels)
				? [
						...service.labels,
						...Object.entries(identityLabels).map(
							([key, value]) => `${key}=${value}`,
						),
					]
				: { ...normalizeComposeLabels(service.labels), ...identityLabels };
		}
		composeServices[serviceName] = service;
		if (volume && !inMemory) {
			composeVolumes[volume] = {};
		}
	}

	for (const [volumeName, volume] of Object.entries(docker?.volumes ?? {})) {
		if (!inMemory || external.has(volumeName))
			composeVolumes[volumeName] = volume;
	}

	const document: ComposeDocument = {
		name: "$" + "{COMPOSE_PROJECT_NAME}",
		services: composeServices,
	};
	if (Object.keys(composeVolumes).length > 0) {
		document.volumes = composeVolumes;
	}
	return document;
}
