import { createHash } from "node:crypto";
import { join } from "node:path";
import { matchesProcessIdentity } from "../process-identity";
import type { RunEntry } from "../run-registry";
import { defaultServiceProtocol } from "../service-presets";
import type { Peer } from "./client";
import { serveTarget } from "./endpoint";
import { createGate } from "./gate";
import {
	type Mapping,
	type Mappings,
	mappingPort,
	occupiedMappingPorts,
} from "./mappings";
import {
	DIRECTORY_PORT,
	type Directory,
	type RemoteRun,
	type RemoteTarget,
	ready,
	validPort,
} from "./protocol";

export interface LocalTarget {
	id: string;
	name: string;
	kind: "app" | "service";
	protocol: "http" | "tcp";
	status: RemoteTarget["status"];
	preset?: string;
	port: number;
	pid?: number;
	processIdentity?: string;
}

/** Derive metadata from the existing registry; never publish local paths, commands or database passwords. */
export function runTargets(run: RunEntry): LocalTarget[] {
	return [
		...run.apps.flatMap<LocalTarget>((a) => {
			if (a.kind === "worker" || !validPort(a.port)) return [];
			return [
				{
					id: `app-${a.name}`,
					name: a.name,
					kind: "app",
					protocol: a.protocol ?? "http",
					status:
						a.pid && !matchesProcessIdentity(a.pid, a.processIdentity)
							? "stopped"
							: a.status,
					port: a.port,
					pid: a.pid,
					processIdentity: a.processIdentity,
				},
			];
		}),
		...run.services.flatMap<LocalTarget>((s) => {
			if (!validPort(s.port)) return [];
			return [
				{
					id: `service-${s.name}`,
					name: s.name,
					kind: "service",
					protocol: s.protocol ?? defaultServiceProtocol(s.preset),
					status: s.status,
					preset: s.preset,
					port: s.port,
				},
			];
		}),
	];
}

interface Published {
	gate: Awaited<ReturnType<typeof createGate>>;
	mapping: Mapping;
	run: RunEntry;
	target: LocalTarget;
}

export function createPublisher(mappings: Mappings, directory: string) {
	const published = new Map<string, Published>();
	const retire = async (key: string, entry: Published) => {
		entry.gate.disable();
		await mappings.remove(entry.mapping);
		await entry.gate.close();
		published.delete(key);
	};
	return {
		async refresh(self: Peer, runs: RunEntry[]): Promise<Directory> {
			const projected = runs
				.filter((run) => run.sessionId)
				.map((run) => ({
					run,
					targets: runTargets(run),
				}));
			const wanted = new Map<string, { run: RunEntry; target: LocalTarget }>();
			for (const { run, targets } of projected) {
				for (const target of targets)
					if (ready(target.status))
						wanted.set(`${run.sessionId}:${target.id}`, { run, target });
			}
			for (const [key, entry] of published) {
				const next = wanted.get(key);
				if (
					!next ||
					next.target.port !== entry.target.port ||
					next.target.protocol !== entry.mapping.protocol ||
					self.hostname !== entry.mapping.hostname
				)
					await retire(key, entry);
				else {
					entry.run = next.run;
					entry.target = next.target;
				}
			}
			const config = await mappings.state();
			const occupied = occupiedMappingPorts(config);
			occupied.add(DIRECTORY_PORT);
			// Reserve mappings awaiting restoration before allocating ports for new targets.
			for (const entry of published.values()) occupied.add(entry.mapping.port);
			for (const [key, { run, target }] of wanted) {
				const existing = published.get(key);
				if (existing) {
					await mappings.restore(existing.mapping, config);
					continue;
				}
				const port = mappingPort(`${run.root}:${target.id}`, occupied);
				occupied.add(port);
				const path = join(
					directory,
					`${createHash("sha256").update(key).digest("hex").slice(0, 16)}.sock`,
				);
				const gate = await createGate(path, target.port, () => {
					const current = published.get(key);
					return (
						!!current &&
						ready(current.target.status) &&
						matchesProcessIdentity(
							current.run.pid,
							current.run.processIdentity,
						) &&
						(!current.target.pid ||
							matchesProcessIdentity(
								current.target.pid,
								current.target.processIdentity,
							))
					);
				});
				const mapping: Mapping = {
					hostname: self.hostname,
					port,
					protocol: target.protocol,
					target: serveTarget(gate.target, target.protocol),
				};
				try {
					await mappings.acquire(mapping);
					published.set(key, {
						gate,
						mapping,
						run,
						target,
					});
				} catch (error) {
					await gate.close();
					throw error;
				}
			}
			const remoteRuns: RemoteRun[] = [];
			for (const { run, targets: localTargets } of projected) {
				const targets: RemoteTarget[] = [];
				for (const target of localTargets) {
					const entry = published.get(`${run.sessionId}:${target.id}`);
					if (!entry) continue;
					targets.push({
						id: target.id,
						name: target.name,
						kind: target.kind,
						protocol: target.protocol,
						status: target.status,
						preset: target.preset,
						port: entry.mapping.port,
						url: `${target.protocol === "http" ? "https" : "tcp"}://${self.hostname}:${entry.mapping.port}/`,
					});
				}
				if (targets.length)
					remoteRuns.push({
						sessionId: `${self.id}:${run.sessionId}`,
						machineId: self.id,
						hostname: self.hostname,
						project: run.projectPrefix,
						branch: run.branch,
						worktree: run.worktree,
						primaryApp: targets.some(
							(t) => t.kind === "app" && t.name === run.primaryApp,
						)
							? run.primaryApp
							: undefined,
						targets,
					});
			}
			return {
				version: 1,
				machineId: self.id,
				hostname: self.hostname,
				generatedAt: Date.now(),
				runs: remoteRuns,
			};
		},
		async close() {
			for (const entry of published.values()) entry.gate.disable();
			for (const [key, entry] of published) await retire(key, entry);
		},
	};
}
