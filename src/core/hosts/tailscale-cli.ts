/**
 * The one place buncargo runs `tailscale`, and how it reads what that prints:
 * this machine's name and HTTPS readiness, the live Serve config, and whether
 * this user may change it. What buncargo adds to Serve, and when it takes it
 * out again, is `tailscale-serve.ts`.
 */

import { existsSync } from "node:fs";
import { getErrorMessage, promiseTimeout } from "hanzio";
import { connectProcessEnv } from "../child-env";
import { lookupOnPath } from "../tool-binary";

// ═══════════════════════════════════════════════════════════════════════════
// The tailscale CLI
// ═══════════════════════════════════════════════════════════════════════════

export interface TailscaleCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs `tailscale <args>`. Throws when there is no `tailscale` to run. */
export type TailscaleCli = (
	args: readonly string[],
) => Promise<TailscaleCommandResult>;

/** The macOS app's CLI, for a Mac without `tailscale` on `PATH`. */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const COMMAND_TIMEOUT_MS = 10_000;

function resolveTailscaleBinary(): string | undefined {
	const onPath = lookupOnPath("tailscale");
	if (onPath) return onPath;
	return process.platform === "darwin" && existsSync(MAC_APP_CLI)
		? MAC_APP_CLI
		: undefined;
}

/** The real `tailscale`, one process per call. */
export const tailscaleCli: TailscaleCli = async (args) => {
	const binary = resolveTailscaleBinary();
	if (!binary)
		throw new Error(
			"the tailscale CLI is not installed (not on PATH). Install Tailscale, or unset BUNCARGO_HOSTS=tailscale.",
		);
	const child = Bun.spawn([binary, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: connectProcessEnv(),
		timeout: COMMAND_TIMEOUT_MS,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
};

/** The first line `tailscale` printed about a failure. */
export function failureLine(result: TailscaleCommandResult): string {
	const line = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((text) => text.trim())
		.find((text) => text.length > 0);
	return line ?? `exit code ${result.exitCode}`;
}

export async function runCli(
	cli: TailscaleCli,
	args: readonly string[],
): Promise<TailscaleCommandResult> {
	try {
		return await cli(args);
	} catch (error) {
		return { exitCode: 127, stdout: "", stderr: getErrorMessage(error) };
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// This machine on the tailnet
// ═══════════════════════════════════════════════════════════════════════════

export type TailscaleSelf =
	| {
			ok: true;
			hostname: string;
			/** The machine's Tailscale IPv4: probes connect here, needing no DNS. */
			address: string;
	  }
	| { ok: false; reason: string };

interface TailscaleStatusJson {
	BackendState?: unknown;
	CertDomains?: unknown;
	Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
}

/**
 * Whether Tailscale can serve HTTPS here, and under which name, from
 * `tailscale status --json`.
 *
 * The name is always the machine's MagicDNS name, never `BUNCARGO_URL_HOST`:
 * Tailscale issues its certificate for that name alone, so any other name
 * fails TLS. Pure, so every refusal is tested without a tailnet.
 */
export function describeTailscaleStatus(
	result: TailscaleCommandResult,
): TailscaleSelf {
	if (result.exitCode !== 0)
		return {
			ok: false,
			reason: `Tailscale is not reachable (${failureLine(result)}). Start it and run \`tailscale up\`.`,
		};
	let status: TailscaleStatusJson;
	try {
		status = JSON.parse(result.stdout) as TailscaleStatusJson;
	} catch {
		return {
			ok: false,
			reason: "`tailscale status --json` printed something that is not JSON.",
		};
	}
	if (status.BackendState !== "Running")
		return {
			ok: false,
			reason: `Tailscale is not connected (state ${String(status.BackendState ?? "unknown")}). Run \`tailscale up\`.`,
		};
	const dnsName =
		typeof status.Self?.DNSName === "string"
			? status.Self.DNSName.replace(/\.$/, "")
			: "";
	if (!dnsName)
		return {
			ok: false,
			reason:
				"This machine has no MagicDNS name. Turn on MagicDNS in the Tailscale admin console (DNS).",
		};
	const certDomains = Array.isArray(status.CertDomains)
		? status.CertDomains
		: [];
	if (!certDomains.includes(dnsName))
		return {
			ok: false,
			reason: `Tailscale has no HTTPS certificate for ${dnsName}. Turn on HTTPS Certificates in the Tailscale admin console (DNS).`,
		};
	const ips = Array.isArray(status.Self?.TailscaleIPs)
		? status.Self.TailscaleIPs
		: [];
	const address = ips.find(
		(ip): ip is string => typeof ip === "string" && ip.includes("."),
	);
	if (!address)
		return {
			ok: false,
			reason:
				"Tailscale reports no IPv4 address for this machine. Run `tailscale up`.",
		};
	return { ok: true, hostname: dnsName, address };
}

export async function readTailscaleSelf(
	cli: TailscaleCli,
): Promise<TailscaleSelf> {
	return describeTailscaleStatus(
		await runCli(cli, ["status", "--json", "--peers=false"]),
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// The live serve config
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What Tailscale Serve does on one port: proxy `/` of `hostname` to `target`,
 * or `"other"` for anything else (more paths, a different backend type, TCP
 * forwarding), which buncargo never adds and so never touches.
 */
export type ServedPort = { hostname: string; target: string } | "other";

/** `tailscale serve status --json`, by port. */
export type ServeConfig = ReadonlyMap<number, ServedPort>;

interface ServeConfigJson {
	TCP?: Record<string, unknown>;
	Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
	/** Sessions of a foreground `tailscale serve`, each a config of its own. */
	Foreground?: Record<string, ServeConfigJson>;
}

/** Every port `config` holds, as `"other"`. */
function portsOf(config: ServeConfigJson): number[] {
	const webPorts = Object.keys(config.Web ?? {}).map((hostPort) =>
		Number(hostPort.slice(hostPort.lastIndexOf(":") + 1)),
	);
	return [...Object.keys(config.TCP ?? {}).map(Number), ...webPorts];
}

/** The one proxied root a Web entry has, or undefined for anything else. */
function proxiedRoot(web: {
	Handlers?: Record<string, { Proxy?: unknown }>;
}): string | undefined {
	const handlers = Object.entries(web.Handlers ?? {});
	const [only] = handlers;
	if (handlers.length !== 1 || only === undefined || only[0] !== "/")
		return undefined;
	const proxy = only[1].Proxy;
	return typeof proxy === "string" ? proxy : undefined;
}

export function parseServeConfig(stdout: string): ServeConfig | undefined {
	let json: ServeConfigJson;
	try {
		json = (stdout.trim() ? JSON.parse(stdout) : {}) as ServeConfigJson;
	} catch {
		return undefined;
	}
	const ports = new Map<number, ServedPort>();
	for (const port of Object.keys(json.TCP ?? {}))
		ports.set(Number(port), "other");
	for (const [hostPort, web] of Object.entries(json.Web ?? {})) {
		const colon = hostPort.lastIndexOf(":");
		const target = proxiedRoot(web);
		const served: ServedPort =
			target === undefined
				? "other"
				: { hostname: hostPort.slice(0, colon), target };
		ports.set(Number(hostPort.slice(colon + 1)), served);
	}
	// A foreground session is someone's terminal: never buncargo's.
	for (const session of Object.values(json.Foreground ?? {}))
		for (const port of portsOf(session)) ports.set(port, "other");
	return ports;
}

export async function readServeConfig(
	cli: TailscaleCli,
): Promise<{ config: ServeConfig } | { reason: string }> {
	const result = await runCli(cli, ["serve", "status", "--json"]);
	if (result.exitCode !== 0)
		return {
			reason: `could not read the Tailscale Serve config (${failureLine(result)}). Check \`tailscale serve status\` and \`buncargo doctor\``,
		};
	const config = parseServeConfig(result.stdout);
	return config
		? { config }
		: {
				reason: "`tailscale serve status --json` printed something unexpected",
			};
}

/** Another writer changed the serve config between our read and write. */
function isEtagConflict(result: TailscaleCommandResult): boolean {
	return /etag mismatch|another client is changing the serve config/i.test(
		`${result.stderr}\n${result.stdout}`,
	);
}

const SERVE_ATTEMPTS = 5;

/**
 * One `tailscale serve` change, retried while another writer holds the
 * config. Changes are never run in parallel: Tailscale writes the whole
 * config under an etag, so concurrent calls fail rather than merge.
 */
export async function runServeChange(
	cli: TailscaleCli,
	args: readonly string[],
): Promise<TailscaleCommandResult> {
	let result = await runCli(cli, args);
	for (
		let attempt = 1;
		attempt < SERVE_ATTEMPTS && isEtagConflict(result);
		attempt++
	) {
		await promiseTimeout(50 * attempt);
		result = await runCli(cli, args);
	}
	return result;
}

/** Tailscale refused the change: on Linux, Serve takes root or the operator permission. */
export function isPermissionDenied(result: TailscaleCommandResult): boolean {
	return /access denied|permission|operator/i.test(
		`${result.stderr}\n${result.stdout}`,
	);
}

/**
 * Whether this user may change Tailscale Serve, from `tailscale debug prefs`:
 * on Linux that takes root or the operator permission. Macs ask the app,
 * which allows the signed-in user, so there is nothing to check.
 */
export function describeServePermission(
	result: TailscaleCommandResult | undefined,
	user: { name: string; uid: number },
): { ok: boolean; message: string } | undefined {
	if (!result) return undefined;
	if (user.uid === 0)
		return {
			ok: true,
			message: "Running as root, which may change Tailscale Serve",
		};
	let operator: unknown;
	try {
		operator = (JSON.parse(result.stdout) as { OperatorUser?: unknown })
			.OperatorUser;
	} catch {
		operator = undefined;
	}
	if (result.exitCode !== 0 || operator === undefined)
		return {
			ok: true,
			message: `warning: could not read Tailscale's operator (${failureLine(result)}); \`tailscale serve\` needs root or \`sudo tailscale set --operator=${user.name}\``,
		};
	return operator === user.name
		? {
				ok: true,
				message: `${user.name} is Tailscale's operator and may change Serve`,
			}
		: {
				ok: false,
				message: `${user.name} may not change Tailscale Serve: run \`sudo tailscale set --operator=${user.name}\``,
			};
}
