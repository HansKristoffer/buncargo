import { existsSync } from "node:fs";
import { execAsync } from "../process/exec";
import { tailscaleBinaryOverride } from "../runtime-flags";
import { recordStartupMetric } from "../startup-metrics";

/** Availability failures may fall back locally after successful rollback. */
export class TailnetUnavailableError extends Error {}

// ── CLI wrapper ──────────────────────────────────────────────────────────────

export type TailscaleCommand = (
	args: string[],
	signal?: AbortSignal,
) => Promise<string>;

/** Resolve the Tailscale binary: env override, macOS app bundle, then PATH. */
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
			signal?.throwIfAborted();
			recordStartupMetric("tailnetCommands");
			const result = await execAsync(
				[binary, ...args],
				process.cwd(),
				{ TAILSCALE_BE_CLI: "1" },
				{
					timeoutMs: 20000,
					killGraceMs: 250,
					maxBufferBytes: 2 * 1024 * 1024,
					signal,
				},
			);

			return result.stdout;
		} catch (error) {
			signal?.throwIfAborted();
			throw new TailnetUnavailableError(
				`Tailscale ${args[0]} failed. Check that Tailscale is connected and this user can run its CLI. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid Tailscale JSON object");
	}

	return value as Record<string, unknown>;
}

export function optionalRecord(value: unknown): Record<string, unknown> {
	return value === undefined ? {} : record(value);
}

// ── Status parsing ───────────────────────────────────────────────────────────

export interface TailnetPeer {
	id: string;
	hostname: string;
	online: boolean;
}

export function parsePeer(value: unknown): TailnetPeer {
	const v = record(value);

	if (typeof v.ID !== "string" || typeof v.DNSName !== "string") {
		throw new Error("Missing Tailscale device identity or MagicDNS name");
	}

	const hostname = v.DNSName.replace(/\.$/, "").toLowerCase();

	if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)) {
		throw new Error("Enable MagicDNS to use buncargo tailnet access");
	}

	return { id: v.ID, hostname, online: v.Online === true };
}

export async function tailnetStatus(command: TailscaleCommand) {
	const v = record(JSON.parse(await command(["status", "--json"])));

	if (v.BackendState !== "Running") {
		throw new TailnetUnavailableError(
			"Connect Tailscale before enabling tailnet access",
		);
	}

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

// ── Serve state ────────────────────────────────────────────────────────────────

export async function serveState(command: TailscaleCommand) {
	return record(JSON.parse(await command(["serve", "status", "--json"])));
}

/**
 * Classify whether `hostname:port` is unmapped, owned by buncargo, or held
 * by another Serve configuration.
 */
export function mappingState(
	state: Record<string, unknown>,
	hostname: string,
	port: number,
	target: string,
): "free" | "owned" | "conflict" {
	const address = `${hostname}:${port}`;
	const tcp = optionalRecord(state.TCP)[String(port)];
	const web = optionalRecord(state.Web)[address];

	if (optionalRecord(state.AllowFunnel)[address] === true) {
		return "conflict";
	}

	// Foreground Serve sessions are separate owners, even when forwarding to us.
	for (const session of Object.values(optionalRecord(state.Foreground))) {
		const config = record(session);

		if (
			optionalRecord(config.TCP)[String(port)] !== undefined ||
			optionalRecord(config.Web)[address] !== undefined
		) {
			return "conflict";
		}
	}

	if (tcp === undefined && web === undefined) {
		return "free";
	}

	if (tcp === undefined || web === undefined) {
		return "conflict";
	}

	const handler = optionalRecord(record(web).Handlers);

	if (Object.keys(handler).length !== 1 || !handler["/"]) {
		return "conflict";
	}

	const proxy = record(handler["/"]);

	return record(tcp).HTTPS === true &&
		Object.keys(record(tcp)).length === 1 &&
		proxy.Proxy === target &&
		Object.keys(proxy).length === 1
		? "owned"
		: "conflict";
}
