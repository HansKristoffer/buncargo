import { describe, expect, it } from "bun:test";
import {
	describeServePermission,
	describeTailscaleStatus,
	parseServeConfig,
	type TailscaleCommandResult,
} from "./tailscale-cli";

const HOST = "box.tail1234.ts.net";

const ok = (stdout = ""): TailscaleCommandResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});
const fail = (stderr: string): TailscaleCommandResult => ({
	exitCode: 1,
	stdout: "",
	stderr,
});

const runningStatus = JSON.stringify({
	BackendState: "Running",
	CertDomains: [HOST],
	Self: { DNSName: `${HOST}.`, TailscaleIPs: ["fd7a::9", "100.64.0.9"] },
});

describe("describeTailscaleStatus", () => {
	it("names the machine by its MagicDNS name, without the trailing dot, and its IPv4", () => {
		expect(describeTailscaleStatus(ok(runningStatus))).toEqual({
			ok: true,
			hostname: HOST,
			address: "100.64.0.9",
		});
	});

	it("says what to do when Tailscale cannot serve HTTPS here", () => {
		const reason = (result: TailscaleCommandResult) => {
			const self = describeTailscaleStatus(result);
			return self.ok ? "" : self.reason;
		};
		expect(
			reason(
				fail(
					"failed to connect to local tailscaled; it doesn't appear to be running",
				),
			),
		).toContain("failed to connect to local tailscaled");
		expect(
			reason(ok(JSON.stringify({ BackendState: "NeedsLogin", Self: {} }))),
		).toContain("`tailscale up`");
		expect(
			reason(
				ok(
					JSON.stringify({
						BackendState: "Running",
						CertDomains: null,
						Self: { DNSName: `${HOST}.` },
					}),
				),
			),
		).toContain("HTTPS Certificates");
		expect(
			reason(ok(JSON.stringify({ BackendState: "Running", Self: {} }))),
		).toContain("MagicDNS");
	});
});

describe("parseServeConfig", () => {
	it("reads a single proxied root per port, and anything else as someone else's", () => {
		const config = parseServeConfig(
			JSON.stringify({
				TCP: { "443": { HTTPS: true }, "25173": { HTTPS: true }, "2222": {} },
				Web: {
					[`${HOST}:443`]: {
						Handlers: {
							"/": { Proxy: "http://127.0.0.1:3773" },
							"/health": { Proxy: "http://127.0.0.1:7979" },
						},
					},
					[`${HOST}:25173`]: {
						Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } },
					},
				},
			}),
		);
		expect(config?.get(443)).toBe("other");
		expect(config?.get(2222)).toBe("other");
		expect(config?.get(25173)).toEqual({
			hostname: HOST,
			target: "http://127.0.0.1:5173",
		});
		// Someone's `tailscale serve` in a terminal holds its ports too.
		const foreground = parseServeConfig(
			JSON.stringify({
				Foreground: {
					session: {
						TCP: { "25000": { HTTPS: true } },
						Web: {
							[`${HOST}:25000`]: {
								Handlers: { "/": { Proxy: "http://127.0.0.1:5000" } },
							},
						},
					},
				},
			}),
		);
		expect(foreground?.get(25000)).toBe("other");
		expect(parseServeConfig("{}")?.size).toBe(0);
		expect(parseServeConfig("")?.size).toBe(0);
		expect(parseServeConfig("not json")).toBeUndefined();
	});
});

describe("describeServePermission", () => {
	const dev = { name: "dev", uid: 1000 };

	it("allows root and the operator, and names the fix for anyone else", () => {
		expect(
			describeServePermission(ok("{}"), { name: "root", uid: 0 })?.ok,
		).toBe(true);
		expect(
			describeServePermission(ok(JSON.stringify({ OperatorUser: "dev" })), dev)
				?.ok,
		).toBe(true);
		const other = describeServePermission(
			ok(JSON.stringify({ OperatorUser: "" })),
			dev,
		);
		expect(other?.ok).toBe(false);
		expect(other?.message).toContain("sudo tailscale set --operator=dev");
		expect(describeServePermission(undefined, dev)).toBeUndefined();
	});
});
