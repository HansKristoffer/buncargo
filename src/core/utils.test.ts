import { describe, expect, it, spyOn } from "bun:test";
import { defineDevConfig } from "../config";
import { applyIntegrations } from "../config/integrations";
import { resolveApps, resolveServices } from "../config/resolve";
import { service } from "../docker-compose/services";
import { createDevEnvironment } from "../environment";
import type { AppConfig, HostsOptionsLike, ServiceConfig } from "../types";
import { planNamedHosts } from "./hosts/plan";
import {
	pidRouteOwners,
	routesFromPlan,
	upsertHostRoutes,
} from "./hosts/registry";
import { activateTailscaleServe } from "./hosts/tailscale-serve";
import { getOffsetClaimsPath } from "./offset-claims";
import { computeDevIdentity, findMonorepoRoot } from "./ports";
import * as registryFile from "./registry-file";
import { adoptLiveCaptures } from "./run-publish";
import { buildRunEntry, publishRun } from "./run-registry";
import { useTempHome, withoutCiEnv } from "./test-env.testing";
import { getEnvVar } from "./utils";

// Each test reads and writes the registry and claims of a home of its own.
useTempHome();

/**
 * A run of this checkout serving named hosts, as the registry records it:
 * what `getEnvVar` reads as the named URLs being live.
 */
async function withServingRun(
	config: HostsTestConfig,
	check: () => void,
	/** Only these plan entries' routes, by name; all of them when absent. */
	only?: string[],
): Promise<void> {
	await upsertHostRoutes(
		routesFromPlan(
			planFor(config).filter(
				(entry) => only === undefined || only.includes(entry.name),
			),
			{ root: findMonorepoRoot(), pid: process.pid },
		),
		{ owners: pidRouteOwners },
	);
	withoutCiEnv(check);
}

/** The plan a run of this checkout serves, from the ports `getEnvVar` reports. */
interface HostsTestConfig {
	projectPrefix: string;
	services: Record<string, ServiceConfig>;
	apps?: Record<string, AppConfig>;
	options?: {
		hosts?: boolean | HostsOptionsLike;
		primaryApp?: string;
		worktreeIsolation?: boolean;
	};
}

function planFor(config: HostsTestConfig) {
	const root = findMonorepoRoot();
	const applied = applyIntegrations(config, { root });
	const identity = computeDevIdentity({
		projectPrefix: applied.projectPrefix,
		root,
		worktreeIsolation: applied.options?.worktreeIsolation,
	});
	const apps = (applied.apps ?? {}) as Record<string, AppConfig>;
	const ports = Object.fromEntries(
		Object.keys(apps).map((name) => [
			name,
			Number(getEnvVar(config as never, `${name.toUpperCase()}_PORT` as never)),
		]),
	);
	return planNamedHosts({
		projectPrefix: applied.projectPrefix,
		worktreeSuffix: identity.worktreeSuffix,
		apps: resolveApps(apps),
		services: resolveServices(applied.services),
		ports,
		hosts: applied.options?.hosts ?? true,
		primaryApp: applied.options?.primaryApp,
	});
}

describe("getEnvVar", () => {
	it("returns shared computed env values and service-derived aliases", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
				nats: service.custom({
					port: 4222,
					env: {
						NATS_URL: "url",
					},
					docker: {
						image: "nats:2-alpine",
					},
				}),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
				web: {
					port: 5173,
					devCommand: "bun run web",
					envVars: (_ports, urls) => ({
						VITE_API_URL: urls.api,
					}),
				},
			},
		});

		const webPort = getEnvVar(config, "WEB_PORT");
		expect(typeof webPort).toBe("number");
		expect(webPort).toBeGreaterThanOrEqual(5173);
		expect(getEnvVar(config, "DATABASE_URL")).toMatch(
			/^postgresql:\/\/postgres:postgres@localhost:\d+\/typed$/,
		);
		expect(getEnvVar(config, "NATS_URL")).toMatch(/^http:\/\/localhost:\d+$/);
		expect(getEnvVar(config, "API_URL")).toMatch(/^http:\/\/localhost:\d+$/);
		expect(getEnvVar(config, "WEBLOCAL_URL")).toMatch(/^http:\/\//);
	});

	it("emits named HTTPS URLs when hosts are enabled", async () => {
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.BUNCARGO_HOSTS;
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {
					postgres: service.postgres({ database: "typed" }),
				},
				apps: {
					api: { port: 3000, devCommand: "bun run api" },
				},
				options: { hosts: true },
			});
			await withServingRun(config, () => {
				expect(getEnvVar(config, "API_URL")).toMatch(
					/^https:\/\/(?:[a-z0-9-]+\.)?api\.serpier\.localhost$/,
				);
				// Playwright and the Stripe CLI cannot use the named URL, so the
				// loopback address has to survive the rewrite alongside it.
				expect(getEnvVar(config, "API_LOOPBACK_URL")).toMatch(
					/^http:\/\/localhost:\d+$/,
				);
				expect(getEnvVar(config, "POSTGRES_LOOPBACK_URL")).toMatch(
					/^postgresql:\/\/postgres:postgres@localhost:\d+\/typed$/,
				);
			});
		} finally {
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});

	// A takeover that ended took one app's route with it, and every other app
	// of the run, still on its named URL, read localhost from its own config.
	it("names each app whose route is live, whatever the others' are", async () => {
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.BUNCARGO_HOSTS;
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {},
				apps: {
					api: { port: 3000, devCommand: "bun run api" },
					web: { port: 5173, devCommand: "bun run web" },
				},
				options: { hosts: true },
			});
			await withServingRun(config, () => {
				expect(getEnvVar(config, "WEB_URL")).toMatch(
					/^https:\/\/(?:[a-z0-9-]+\.)?web\.serpier\.localhost$/,
				);
				expect(getEnvVar(config, "API_URL")).toMatch(
					/^http:\/\/localhost:\d+$/,
				);
			}, ["web"]);
		} finally {
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});

	// The plan alone handed a vite.config an https URL while the run was on
	// localhost:port, or with no run at all; `env` said localhost meanwhile.
	it("keeps localhost URLs while no run of the checkout serves its named hosts", () => {
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.BUNCARGO_HOSTS;
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {},
				apps: { api: { port: 3000, devCommand: "bun run api" } },
				options: { hosts: true },
			});
			expect(withoutCiEnv(() => getEnvVar(config, "API_URL"))).toMatch(
				/^http:\/\/localhost:\d+$/,
			);
		} finally {
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});

	it("gives the primary app the bare hostname a run serves it on", async () => {
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.BUNCARGO_HOSTS;
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {},
				apps: {
					api: { port: 3000, devCommand: "bun run api" },
					web: { port: 5173, devCommand: "bun run web" },
				},
				options: { hosts: true, primaryApp: "web" },
			});
			await withServingRun(config, () => {
				expect(getEnvVar(config, "WEB_URL")).toMatch(
					/^https:\/\/(?:[a-z0-9-]+\.)?serpier\.localhost$/,
				);
				expect(getEnvVar(config, "WEB_URL")).not.toContain("web.");
				expect(getEnvVar(config, "API_URL")).toMatch(
					/^https:\/\/(?:[a-z0-9-]+\.)?api\.serpier\.localhost$/,
				);
			});
		} finally {
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});

	it("sees what the config's integrations add, like a run does", async () => {
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.BUNCARGO_HOSTS;
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {},
				apps: {
					api: { port: 3000, devCommand: "bun run api" },
					web: { port: 5173, devCommand: "bun run web" },
				},
				options: { hosts: true },
				// Shopify's sets its frontend as the primary app this way.
				integrations: [
					{
						name: "primary",
						config: (config) => ({
							...config,
							options: { ...config.options, primaryApp: "web" },
						}),
					},
				],
			});
			await withServingRun(config, () => {
				expect(getEnvVar(config, "WEB_URL")).not.toContain("web.");
			});
		} finally {
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});

	it.each([["BUNCARGO_HOSTS", "0"]])(
		"keeps localhost URLs when %s=%s",
		(name, value) => {
			const previousHosts = process.env[name];
			process.env[name] = value;
			try {
				withoutCiEnv(() => {
					const config = defineDevConfig({
						projectPrefix: "serpier",
						services: {
							postgres: service.postgres({ database: "typed" }),
						},
						apps: {
							api: { port: 3000, devCommand: "bun run api" },
						},
						options: { hosts: true },
					});
					expect(getEnvVar(config, "API_URL")).toMatch(
						/^http:\/\/localhost:\d+$/,
					);
				});
			} finally {
				if (previousHosts === undefined) delete process.env[name];
				else process.env[name] = previousHosts;
			}
		},
	);

	it("emits the Tailscale URL a live run of the checkout serves, and the plain one before", async () => {
		const saved = {
			BUNCARGO_HOSTS: process.env.BUNCARGO_HOSTS,
			BUNCARGO_URL_HOST: process.env.BUNCARGO_URL_HOST,
		};
		process.env.BUNCARGO_HOSTS = "tailscale";
		delete process.env.BUNCARGO_URL_HOST;
		const config = defineDevConfig({
			projectPrefix: "serpier",
			services: {},
			apps: { api: { port: 3000, devCommand: "bun run api" } },
			options: { hosts: true },
		});
		try {
			const port = Number(withoutCiEnv(() => getEnvVar(config, "API_PORT")));
			expect(withoutCiEnv(() => getEnvVar(config, "API_URL"))).toBe(
				`http://localhost:${port}`,
			);

			const host = "box.tail1234.ts.net";
			await activateTailscaleServe(
				{
					root: findMonorepoRoot(),
					pid: process.pid,
					apps: [{ name: "api", port }],
					blockPorts: [port],
					takeover: new Set(),
				},
				{
					cli: async (args) => ({
						exitCode: 0,
						stderr: "",
						stdout:
							args[0] === "status"
								? JSON.stringify({
										BackendState: "Running",
										CertDomains: [host],
										Self: {
											DNSName: `${host}.`,
											TailscaleIPs: ["100.64.0.9"],
										},
									})
								: args[1] === "status"
									? "{}"
									: "",
					}),
					probe: async () => undefined,
					ownersAlive: () => () => true,
				},
			);
			expect(withoutCiEnv(() => getEnvVar(config, "API_URL"))).toBe(
				`https://${host}:${port + 20_000}`,
			);
			expect(withoutCiEnv(() => getEnvVar(config, "API_LOOPBACK_URL"))).toBe(
				`http://localhost:${port}`,
			);
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

describe("getEnvVar against the run", () => {
	const config = defineDevConfig({
		projectPrefix: "parity",
		services: {},
		apps: {
			tunnel: {
				port: 4040,
				devCommand: "bun run tunnel",
				captures: {
					tunnelUrl: {
						pattern: /url=(\S+)/,
						as: "value",
						env: "PUBLIC_TUNNEL_URL",
					},
				},
			},
		},
		env: (_ports, _urls, ctx) => ({
			TUNNEL_CALLBACK: `${ctx.captured?.tunnelUrl}/callback`,
			WORKSPACE: ctx.workspaceId,
		}),
	});

	// A config.env callback reading captures or the workspace id answered
	// one thing inside an app's vite.config.ts and another in the run.
	it("answers captured env and the workspace id as the run gives them", async () => {
		const root = findMonorepoRoot();
		await publishRun({
			...buildRunEntry({
				sessionId: "parity",
				projectPrefix: "parity",
				projectName: "parity",
				root,
				isWorktree: false,
			}),
			captures: { tunnelUrl: "https://tunnel.example" },
		});
		const run = createDevEnvironment(config, { root });
		await adoptLiveCaptures(run);
		const vars: Record<string, string> = run.buildEnvVars();
		// The capture's env name and BUNCARGO_WORKSPACE_ID are not in the
		// config's typed names.
		const read = (name: string): unknown => getEnvVar(config, name as never);

		for (const name of [
			"PUBLIC_TUNNEL_URL",
			"TUNNEL_CALLBACK",
			"WORKSPACE",
			"BUNCARGO_WORKSPACE_ID",
		])
			expect(read(name)).toBe(vars[name]);
		expect(read("TUNNEL_CALLBACK")).toBe("https://tunnel.example/callback");
	});

	// A vite.config.ts asking for three names read offsets.json, env files and
	// routes three times.
	it("reads the port claims once for several names", () => {
		const claims = getOffsetClaimsPath();
		const reads = spyOn(registryFile, "readJsonDocumentSync");
		try {
			getEnvVar(config, "TUNNEL_PORT");
			getEnvVar(config, "TUNNEL_URL");
			getEnvVar(config, "WORKSPACE");
			const claimReads = reads.mock.calls.filter(([path]) => path === claims);
			expect(claimReads).toHaveLength(1);
		} finally {
			reads.mockRestore();
		}
	});
});
