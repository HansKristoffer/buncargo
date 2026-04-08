import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DevEnvironmentTunnelLog } from "../types";

const REGISTRY_VERSION = 1;
const REGISTRY_TTL_MS = 1000 * 60 * 60 * 24;

interface TunnelRegistryFile {
	version: number;
	entries: TunnelRegistryEntry[];
}

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
	return join(root, ".buncargo", "public-tunnels.json");
}

function isPidAlive(pid: number | undefined): boolean {
	if (pid === undefined) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function keyFor(entry: Pick<TunnelRegistryEntry, "kind" | "name">): string {
	return `${entry.kind}:${entry.name}`;
}

async function readRegistry(
	root: string,
): Promise<{ path: string; entries: TunnelRegistryEntry[] }> {
	const path = getTunnelRegistryPath(root);
	try {
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<TunnelRegistryFile>;
		if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.entries)) {
			return { path, entries: [] };
		}
		return { path, entries: parsed.entries as TunnelRegistryEntry[] };
	} catch {
		return { path, entries: [] };
	}
}

async function writeRegistry(
	path: string,
	entries: TunnelRegistryEntry[],
): Promise<void> {
	if (entries.length === 0) {
		await rm(path, { force: true });
		return;
	}

	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify(
			{
				version: REGISTRY_VERSION,
				entries,
			} satisfies TunnelRegistryFile,
			null,
			2,
		),
	);
}

export async function pruneTunnelRegistry(
	root: string,
	options: { now?: number } = {},
): Promise<TunnelRegistryEntry[]> {
	const { now = Date.now() } = options;
	const { path, entries } = await readRegistry(root);
	const activeEntries = entries.filter((entry) => {
		const updatedAt = Date.parse(entry.updatedAt);
		if (!Number.isFinite(updatedAt)) return false;
		if (now - updatedAt > REGISTRY_TTL_MS) return false;
		return isPidAlive(entry.pid);
	});

	if (activeEntries.length !== entries.length) {
		await writeRegistry(path, activeEntries);
	}

	return activeEntries;
}

export async function upsertTunnelRegistryEntries(
	root: string,
	entriesToSave: TunnelRegistryEntry[],
): Promise<void> {
	const { path, entries } = await readRegistry(root);
	const byKey = new Map(entries.map((entry) => [keyFor(entry), entry]));
	for (const entry of entriesToSave) {
		byKey.set(keyFor(entry), entry);
	}
	await writeRegistry(path, Array.from(byKey.values()));
}

export async function removeTunnelRegistryEntries(
	root: string,
	entriesToRemove: Array<Pick<TunnelRegistryEntry, "kind" | "name" | "pid">>,
): Promise<void> {
	const { path, entries } = await readRegistry(root);
	const toRemove = new Map(
		entriesToRemove.map((entry) => [keyFor(entry), entry.pid]),
	);
	const nextEntries = entries.filter((entry) => {
		const expectedPid = toRemove.get(keyFor(entry));
		if (expectedPid === undefined) return true;
		return entry.pid !== expectedPid;
	});
	await writeRegistry(path, nextEntries);
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
