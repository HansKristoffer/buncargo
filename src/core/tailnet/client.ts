import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { tailscaleBinaryOverride } from "../runtime-flags";

const execute = promisify(execFile);

export type TailscaleCommand = (
	args: string[],
	signal?: AbortSignal,
) => Promise<string>;

export function tailscaleBinary(): string {
	const override = tailscaleBinaryOverride();
	if (override) return override;
	const bundled = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	return existsSync(bundled) ? bundled : "tailscale";
}

export function createTailscaleClient(
	binary = tailscaleBinary(),
): TailscaleCommand {
	return async (args, signal) => {
		try {
			const result = await execute(binary, args, {
				timeout: 20000,
				maxBuffer: 2 * 1024 * 1024,
				signal,
			});
			return result.stdout;
		} catch (error) {
			throw new Error(
				`Tailscale ${args[0]} failed. Check that Tailscale is connected and this user can run its CLI. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
}

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid Tailscale JSON object");
	return value as Record<string, unknown>;
}

export function optionalRecord(value: unknown): Record<string, unknown> {
	return value === undefined ? {} : record(value);
}

export interface TailnetPeer {
	id: string;
	hostname: string;
	online: boolean;
}

export function parsePeer(value: unknown): TailnetPeer {
	const v = record(value);
	if (typeof v.ID !== "string" || typeof v.DNSName !== "string")
		throw new Error("Missing Tailscale device identity or MagicDNS name");
	const hostname = v.DNSName.replace(/\.$/, "").toLowerCase();
	if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname))
		throw new Error("Enable MagicDNS to use buncargo tailnet access");
	return { id: v.ID, hostname, online: v.Online === true };
}

export async function tailnetStatus(command: TailscaleCommand) {
	const v = record(JSON.parse(await command(["status", "--json"])));
	if (v.BackendState !== "Running")
		throw new Error("Connect Tailscale before enabling tailnet access");
	const self = parsePeer(v.Self);
	const peers = Object.values(optionalRecord(v.Peer)).flatMap((value) => {
		try {
			return [parsePeer(value)];
		} catch {
			return [];
		}
	});
	return { self, peers };
}

export async function serveState(command: TailscaleCommand) {
	return record(JSON.parse(await command(["serve", "status", "--json"])));
}

export function mappingState(
	state: Record<string, unknown>,
	hostname: string,
	port: number,
	target: string,
): "free" | "owned" | "conflict" {
	const address = `${hostname}:${port}`;
	const tcp = optionalRecord(state.TCP)[String(port)];
	const web = optionalRecord(state.Web)[address];
	if (optionalRecord(state.AllowFunnel)[address] === true) return "conflict";
	// Foreground Serve sessions are separate owners, even when forwarding to us.
	for (const session of Object.values(optionalRecord(state.Foreground))) {
		const config = record(session);
		if (
			optionalRecord(config.TCP)[String(port)] !== undefined ||
			optionalRecord(config.Web)[address] !== undefined
		)
			return "conflict";
	}
	if (tcp === undefined && web === undefined) return "free";
	if (tcp === undefined || web === undefined) return "conflict";
	const handler = optionalRecord(record(web).Handlers);
	if (Object.keys(handler).length !== 1 || !handler["/"]) return "conflict";
	const proxy = record(handler["/"]);
	return record(tcp).HTTPS === true &&
		Object.keys(record(tcp)).length === 1 &&
		proxy.Proxy === target &&
		Object.keys(proxy).length === 1
		? "owned"
		: "conflict";
}
