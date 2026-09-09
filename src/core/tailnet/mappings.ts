import { createHash } from "node:crypto";
import { sleep } from "../sleep";
import { record, type TailscaleCommand } from "./client";
import { PORT_END, PORT_START } from "./protocol";

export interface Mapping {
	hostname: string;
	port: number;
	protocol: "http" | "tcp";
	target: string;
}
const object = (value: unknown) => (value === undefined ? {} : record(value));

/** Require an exact backend match; foreign foreground sessions and Funnel make a port unavailable. */
export function mappingState(
	raw: unknown,
	mapping: Mapping,
): "free" | "owned" | "conflict" {
	const config = record(raw),
		key = `${mapping.hostname}:${mapping.port}`;
	for (const foreground of Object.values(object(config.Foreground)))
		if (mappingState(foreground, mapping) !== "free") return "conflict";
	const tcp = object(config.TCP)[mapping.port],
		web = object(config.Web)[key];
	if (object(config.AllowFunnel)[key] === true) return "conflict";
	if (tcp === undefined && web === undefined) return "free";
	if (mapping.protocol === "tcp")
		return JSON.stringify(tcp) ===
			JSON.stringify({ TCPForward: mapping.target }) && web === undefined
			? "owned"
			: "conflict";
	const handlers = object(object(web).Handlers);
	return Object.keys(object(web)).length === 1 &&
		JSON.stringify(tcp) === JSON.stringify({ HTTPS: true }) &&
		Object.keys(handlers).length === 1 &&
		JSON.stringify(handlers["/"]) === JSON.stringify({ Proxy: mapping.target })
		? "owned"
		: "conflict";
}

/** Include foreground sessions: their ports are unavailable even outside the background config. */
export function occupiedMappingPorts(raw: unknown): Set<number> {
	const ports = new Set<number>();
	const collect = (value: unknown) => {
		const config = record(value);
		for (const port of Object.keys(object(config.TCP))) ports.add(Number(port));
		for (const foreground of Object.values(object(config.Foreground)))
			collect(foreground);
	};
	collect(raw);
	return ports;
}

export function mappingPort(key: string, occupied: Set<number>): number {
	const offset = createHash("sha256").update(key).digest().readUInt32BE(0);
	for (let i = 0; i <= PORT_END - PORT_START; i++) {
		const port = PORT_START + ((offset + i) % (PORT_END - PORT_START + 1));
		if (!occupied.has(port)) return port;
	}
	throw new Error("No free Tailscale service ports");
}

export interface ServeSession {
	readonly alive: boolean;
	close(): Promise<void>;
}
type StartServe = (args: string[]) => ServeSession;
interface MappingSession {
	child: ServeSession;
	sessionId?: string;
}
export type Mappings = ReturnType<typeof createMappings>;

/** Foreground Serve owns its routes for the lifetime of its CLI connection, with no persisted rules.
 * The parent-pipe guard closes that connection even if the coordinator is killed abruptly.
 */
export function createMappings(command: TailscaleCommand, start: StartServe) {
	const entries = new Map<Mapping, MappingSession>();
	const state = async () =>
		record(JSON.parse(await command(["serve", "status", "--json"])));
	const remove = async (mapping: Mapping) => {
		const entry = entries.get(mapping);
		if (!entry) return;
		await entry.child.close();
		entries.delete(mapping);
	};
	const owned = (config: unknown, mapping: Mapping) => {
		const entry = entries.get(mapping);
		if (!entry?.child.alive || !entry.sessionId) return false;
		const raw = record(config),
			foreground = { ...object(raw.Foreground) };
		const session = foreground[entry.sessionId];
		delete foreground[entry.sessionId];
		return (
			session !== undefined &&
			mappingState(session, mapping) === "owned" &&
			mappingState({ ...raw, Foreground: foreground }, mapping) === "free"
		);
	};
	const acquire = async (mapping: Mapping) => {
		if (mappingState(await state(), mapping) !== "free")
			throw new Error(`Tailscale port ${mapping.port} is already in use`);
		const child = start([
			"serve",
			"--yes",
			`--${mapping.protocol === "http" ? "https" : "tcp"}=${mapping.port}`,
			mapping.target,
		]);
		const entry: MappingSession = { child };
		entries.set(mapping, entry);
		try {
			const deadline = Date.now() + 10000;
			while (child.alive && Date.now() < deadline) {
				const config = await state();
				const matches = Object.entries(object(config.Foreground)).filter(
					([, value]) => mappingState(value, mapping) === "owned",
				);
				if (matches.length === 1) {
					entry.sessionId = matches[0][0];
					if (owned(config, mapping)) return;
				}
				await sleep(50);
			}
			throw new Error(
				`Tailscale did not activate port ${mapping.port}; check Serve permissions and HTTPS settings`,
			);
		} catch (error) {
			await remove(mapping);
			throw error;
		}
	};
	return {
		state,
		acquire,
		remove,
		async restore(mapping: Mapping, config: unknown) {
			if (owned(config, mapping)) return;
			await remove(mapping);
			await acquire(mapping);
		},
		async clear() {
			for (const mapping of entries.keys()) await remove(mapping);
		},
	};
}
