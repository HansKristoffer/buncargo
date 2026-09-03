import { withFileLock } from "../core/file-lock";
import { defineListRegistry, isRouteOwnerAlive } from "../core/registry-file";
import { projectStateFilePath } from "../core/state-paths";
import type { DevEnvironmentTunnelLog } from "../types";

const REGISTRY_VERSION = 1;
const REGISTRY_TTL_MS = 1000 * 60 * 60 * 24;

export interface TunnelRegistryEntry {
	kind: "service" | "app";
	name: string;
	publicUrl: string;
	localUrl: string;
	port: number;
	pid?: number;
	updatedAt: string;
}

export function getTunnelRegistryPath(root: string): string {
	return projectStateFilePath(root, "public-tunnels.json");
}

function isTunnelRegistryEntry(value: unknown): value is TunnelRegistryEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<TunnelRegistryEntry>;
	return (
		(entry.kind === "app" || entry.kind === "service") &&
		typeof entry.name === "string" &&
		typeof entry.publicUrl === "string" &&
		typeof entry.localUrl === "string" &&
		typeof entry.port === "number" &&
		typeof entry.updatedAt === "string" &&
		(entry.pid === undefined || typeof entry.pid === "number")
	);
}

const registry = defineListRegistry<TunnelRegistryEntry>({
	version: REGISTRY_VERSION,
	key: "entries",
	isEntry: isTunnelRegistryEntry,
});

function keyFor(entry: Pick<TunnelRegistryEntry, "kind" | "name">): string {
	return `${entry.kind}:${entry.name}`;
}

/**
 * Locked for the same reason as the hosts route registry: concurrent
 * `--expose` runs in one repo would otherwise drop each other's entries and
 * re-open tunnels that already exist.
 */
export async function pruneTunnelRegistry(
	root: string,
	options: { now?: number } = {},
): Promise<TunnelRegistryEntry[]> {
	const { now = Date.now() } = options;
	const path = getTunnelRegistryPath(root);
	return withFileLock(path, async () => {
		const entries = await registry.read(path);
		const activeEntries = entries.filter((entry) => {
			const updatedAt = Date.parse(entry.updatedAt);
			if (!Number.isFinite(updatedAt)) return false;
			if (now - updatedAt > REGISTRY_TTL_MS) return false;
			return isRouteOwnerAlive(entry.pid);
		});

		if (activeEntries.length !== entries.length) {
			await registry.write(path, activeEntries);
		}

		return activeEntries;
	});
}

export async function upsertTunnelRegistryEntries(
	root: string,
	entriesToSave: TunnelRegistryEntry[],
): Promise<void> {
	const path = getTunnelRegistryPath(root);
	await withFileLock(path, async () => {
		const entries = await registry.read(path);
		const byKey = new Map(entries.map((entry) => [keyFor(entry), entry]));
		for (const entry of entriesToSave) {
			byKey.set(keyFor(entry), entry);
		}
		await registry.write(path, Array.from(byKey.values()));
	});
}

export async function removeTunnelRegistryEntries(
	root: string,
	entriesToRemove: Array<Pick<TunnelRegistryEntry, "kind" | "name" | "pid">>,
): Promise<void> {
	const path = getTunnelRegistryPath(root);
	await withFileLock(path, async () => {
		const entries = await registry.read(path);
		const toRemove = new Map(
			entriesToRemove.map((entry) => [keyFor(entry), entry.pid]),
		);
		const nextEntries = entries.filter((entry) => {
			const expectedPid = toRemove.get(keyFor(entry));
			if (expectedPid === undefined) return true;
			return entry.pid !== expectedPid;
		});
		await registry.write(path, nextEntries);
	});
}

export async function loadReusableTunnelApps(
	root: string,
	options: {
		appNames: string[];
		ports: Record<string, number>;
	},
): Promise<{
	publicUrls: Record<string, string>;
	tunnels: DevEnvironmentTunnelLog[];
	missingAppNames: string[];
}> {
	const { appNames, ports } = options;
	const entries = await pruneTunnelRegistry(root);
	const byKey = new Map(entries.map((entry) => [keyFor(entry), entry]));
	const publicUrls: Record<string, string> = {};
	const tunnels: DevEnvironmentTunnelLog[] = [];
	const missingAppNames: string[] = [];

	for (const name of appNames) {
		const entry = byKey.get(`app:${name}`);
		const port = ports[name];
		if (!entry || port === undefined || entry.port !== port) {
			missingAppNames.push(name);
			continue;
		}
		publicUrls[name] = entry.publicUrl;
		tunnels.push({
			kind: "app",
			name,
			localUrl: entry.localUrl,
			publicUrl: entry.publicUrl,
		});
	}

	return { publicUrls, tunnels, missingAppNames };
}
