import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { tailscaleProcessEnv } from "../runtime-flags";
import { lookupOnPath } from "../tool-binary";

const run = promisify(execFile);
export interface Peer {
	id: string;
	hostname: string;
	online: boolean;
}
export interface TailnetStatus {
	self: Peer;
	peers: Peer[];
}
export type TailscaleCommand = (
	args: string[],
	signal?: AbortSignal,
) => Promise<string>;

export function tailscaleBinary(): string | undefined {
	const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	return existsSync(app) ? app : lookupOnPath("tailscale");
}

/** Error output can contain login URLs or credentials. Expose only the operation and remediation. */
export function createTailscaleClient(
	binary: string,
	socket?: string,
): TailscaleCommand {
	return async (args, signal) => {
		try {
			const result = await run(
				binary,
				[...(socket ? [`--socket=${socket}`] : []), ...args],
				{
					env: tailscaleProcessEnv(),
					timeout: 20000,
					maxBuffer: 2 * 1024 * 1024,
					signal,
					killSignal: "SIGKILL",
				},
			);
			return result.stdout;
		} catch {
			signal?.throwIfAborted();
			throw new Error(
				`Tailscale ${args[0]} failed. Check sign-in, CLI permissions, and MagicDNS/HTTPS in your tailnet.`,
			);
		}
	};
}

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid Tailscale response");
	return value as Record<string, unknown>;
}
export function peer(value: unknown): Peer {
	const v = record(value);
	const hostname =
		typeof v.DNSName === "string"
			? v.DNSName.replace(/\.$/, "").toLowerCase()
			: "";
	if (
		typeof v.ID !== "string" ||
		!v.ID ||
		!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)
	)
		throw new Error(
			"Enable MagicDNS in Tailscale to discover Buncargo environments",
		);
	return { id: v.ID, hostname, online: v.Online === true };
}
export async function tailnetStatus(
	command: TailscaleCommand,
	signal?: AbortSignal,
): Promise<TailnetStatus> {
	const status = record(
		JSON.parse(await command(["status", "--json"], signal)),
	);
	if (status.BackendState !== "Running")
		throw new Error("Sign in to Tailscale to share and discover environments");
	return {
		self: peer(status.Self),
		peers: Object.values(record(status.Peer ?? {})).flatMap((value) => {
			try {
				return [peer(value)];
			} catch {
				return [];
			}
		}),
	};
}
