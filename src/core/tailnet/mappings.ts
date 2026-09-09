import { createHash } from "node:crypto";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { stateFilePath } from "../state-paths";
import { record, type TailscaleCommand } from "./client";
import { PORT_END, PORT_START, validPort } from "./protocol";

export interface Mapping {
	hostname: string;
	port: number;
	protocol: "http" | "tcp";
	target: string;
}
const object = (value: unknown) => (value === undefined ? {} : record(value));

/** Compare the entire mapping, including foreground and Funnel ownership, before removing anything. */
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

/** The coordinator is the sole writer, under its lifetime lock. Journal before external mutations. */
export async function createMappings(
	command: TailscaleCommand,
	path = stateFilePath("tailnet-mappings.json"),
) {
	let entries =
		(await readJsonDocument(path, (value) => {
			if (
				!Array.isArray(value) ||
				!value.every(
					(v) =>
						v &&
						typeof v.hostname === "string" &&
						validPort(v.port) &&
						["http", "tcp"].includes(v.protocol) &&
						typeof v.target === "string" &&
						v.target.startsWith("unix:"),
				)
			)
				return;
			return value as Mapping[];
		})) ?? [];
	const save = () => writeJsonDocument(path, entries);
	const state = async () =>
		record(JSON.parse(await command(["serve", "status", "--json"])));
	const flag = (m: Mapping) =>
		`--${m.protocol === "http" ? "https" : "tcp"}=${m.port}`;
	const remove = async (mapping: Mapping) => {
		const disposition = mappingState(await state(), mapping);
		if (disposition === "conflict")
			throw new Error(
				`Tailscale port ${mapping.port} was changed outside Buncargo; refusing to remove it`,
			);
		if (disposition === "owned")
			await command(["serve", "--bg", flag(mapping), "off"]);
		entries = entries.filter((v) => v !== mapping);
		await save();
	};
	// Initial publication and recovery share journaling and post-command verification.
	const activate = async (mapping: Mapping) => {
		if (!entries.includes(mapping)) {
			entries.push(mapping);
			await save();
		}
		await command(["serve", "--bg", "--yes", flag(mapping), mapping.target]);
		if (mappingState(await state(), mapping) !== "owned")
			throw new Error("Tailscale did not activate the service mapping");
	};
	return {
		state,
		async acquire(mapping: Mapping) {
			if (mappingState(await state(), mapping) !== "free")
				throw new Error(`Tailscale port ${mapping.port} is already in use`);
			await activate(mapping);
		},
		async restore(mapping: Mapping, config: unknown) {
			const disposition = mappingState(config, mapping);
			if (disposition === "conflict")
				throw new Error(`Tailscale port ${mapping.port} has another owner`);
			if (disposition === "free") await activate(mapping);
		},
		remove,
		async clear() {
			let failed = false;
			for (const entry of entries.slice()) {
				try {
					await remove(entry);
				} catch {
					failed = true;
				}
			}
			if (failed)
				throw new Error(
					"Some Buncargo Tailscale mappings could not be removed; check tailscale serve status",
				);
		},
	};
}
