import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	getRoutesPath,
	loadHostRoutes,
	removeHostRoutes,
	upsertHostRoutes,
} from "../core/hosts";
import { pidRouteOwners } from "../core/hosts/registry";
import { useTempHome } from "../core/test-env.testing";
import { lookupOnPath } from "../core/tool-binary";
import type {
	AppConfig,
	DevEnvironment,
	HostsRuntime,
	ServiceConfig,
} from "../types";
import {
	activateNamedHosts,
	type NamedHostsDeps,
	reclaimAppRoute,
} from "./dev-hosts";

// The routes registry lives in ~/.buncargo: each test starts with none.
useTempHome();
let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-reclaim-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const hosts = (active: boolean): HostsRuntime => ({
	active,
	tld: "localhost",
	mode: "loopback",
	tailscaleUrls: {},
	plan: [
		{
			kind: "app",
			name: "web",
			hostname: "web.fixture.localhost",
			baseHostname: "web.fixture.localhost",
			targetPort: 3100,
		},
		{
			kind: "app",
			name: "api",
			hostname: "api.fixture.localhost",
			baseHostname: "api.fixture.localhost",
			targetPort: 3200,
		},
	],
});

/** The warnings that say named URLs fell back to `localhost:port`. */
function namedHostsFallbacks(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("Named URLs unavailable:"));
}

describe("reclaimAppRoute", () => {
	// Run B took `web` over from this run, so the route moved to B; B exited
	// and released it, and `web` restarted here.
	it("claims a restarted app's route back after the run that took it over ended", async () => {
		const other = process.ppid;
		await upsertHostRoutes(
			[
				{
					hostname: "web.fixture.localhost",
					port: 3100,
					kind: "app",
					name: "web",
					root,
					pid: other,
				},
			],
			{ owners: pidRouteOwners },
		);

		// While that run lives, the route stays its own.
		await reclaimAppRoute({ root, hosts: hosts(true) }, "web");
		expect(await loadHostRoutes()).toMatchObject([{ pid: other }]);

		await removeHostRoutes(
			(route) => route.kind === "app" && route.pid === other,
		);
		await reclaimAppRoute({ root, hosts: hosts(true) }, "web");
		expect(await loadHostRoutes()).toMatchObject([
			{ hostname: "web.fixture.localhost", port: 3100, pid: process.pid },
		]);
	});

	// Swallowed, the restarted app served a named URL that 404'd with nothing
	// in its output saying why.
	it("says why when the registry cannot be read", async () => {
		mkdirSync(dirname(getRoutesPath()), { recursive: true });
		writeFileSync(getRoutesPath(), "{ not json");

		const warning = await reclaimAppRoute({ root, hosts: hosts(true) }, "web");

		expect(namedHostsFallbacks(warning ?? "")).toEqual([
			expect.stringContaining(getRoutesPath()),
		]);
	});

	it("claims nothing while named hosts are not serving this run", async () => {
		await reclaimAppRoute({ root, hosts: hosts(false) }, "web");
		await reclaimAppRoute({ root, hosts: null }, "web");
		expect(await loadHostRoutes()).toEqual([]);
	});
});

/** A machine whose daemon is ready and serves whatever it is asked to. */
const readyMachine = (
	overrides: Partial<NamedHostsDeps> = {},
): NamedHostsDeps => ({
	ensureHostsReady: async () => ({ ok: true, caPath: "/ca.pem" }),
	syncCertificateForRoutes: async () => {},
	waitForDaemonRoutes: async () => ({ ok: true }),
	owners: pidRouteOwners,
	...overrides,
});

describe("activateNamedHosts", () => {
	function loopbackEnv() {
		const switches: Array<{ active: boolean; hostnames?: readonly string[] }> =
			[];
		const env = {
			root,
			hosts: hosts(false),
			setNamedHostsActive: (
				active: boolean,
				extras: { hostnames?: readonly string[] } = {},
			) => switches.push({ active, hostnames: extras.hostnames }),
		} as unknown as DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>;
		return { env, switches };
	}

	// An earlier run's service route outlives it; a run that then fell back
	// printed localhost:port while getEnvVar read the named URL as live.
	it("withdraws the checkout's service routes when the daemon is unavailable", async () => {
		await upsertHostRoutes(
			[
				{
					hostname: "typesense.fixture.localhost",
					port: 8108,
					kind: "service",
					name: "typesense",
					root,
				},
			],
			{ owners: pidRouteOwners },
		);
		const { env, switches } = loopbackEnv();

		const warnings = await activateNamedHosts(
			env,
			{ enabled: true },
			readyMachine({
				ensureHostsReady: async () => ({
					ok: false,
					reason: "failed",
					message: "Named-hosts service is not installed.",
				}),
			}),
		);

		expect(warnings).toEqual([
			"Named URLs unavailable: Named-hosts service is not installed.",
		]);
		expect(switches).toEqual([{ active: false, hostnames: undefined }]);
		expect(await loadHostRoutes()).toEqual([]);
	});

	// Every run attaches on startup, mostly with the routes the last run left.
	it("reads the registry once and leaves it unwritten when the routes are already there", async () => {
		const { env, switches } = loopbackEnv();
		env.hosts?.plan.push({
			kind: "service",
			name: "typesense",
			hostname: "typesense.fixture.localhost",
			baseHostname: "typesense.fixture.localhost",
			targetPort: 8108,
		});
		await activateNamedHosts(env, { enabled: true }, readyMachine());
		const written = statSync(getRoutesPath());
		const readFile = spyOn(fsPromises, "readFile");
		try {
			await activateNamedHosts(env, { enabled: true }, readyMachine());

			const reads = readFile.mock.calls.filter(
				([path]) => path === getRoutesPath(),
			);
			expect(reads).toHaveLength(1);
		} finally {
			readFile.mockRestore();
		}
		const after = statSync(getRoutesPath());
		expect([after.ino, after.mtimeMs]).toEqual([written.ino, written.mtimeMs]);
		expect(switches.map((entry) => entry.active)).toEqual([true, true]);
	});

	it("serves the rest of the plan when another checkout holds one hostname", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "buncargo-other-checkout-"));
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "web.fixture.localhost",
						port: 4100,
						kind: "app",
						name: "web",
						root: elsewhere,
						pid: process.ppid,
					},
				],
				{ owners: pidRouteOwners },
			);
			const { env, switches } = loopbackEnv();

			const warnings = await activateNamedHosts(
				env,
				{ enabled: true },
				readyMachine(),
			);

			expect(namedHostsFallbacks(warnings.join("\n"))).toEqual([
				expect.stringContaining(
					`web.fixture.localhost is already registered by ${elsewhere}`,
				),
			]);
			expect(switches).toEqual([
				{ active: true, hostnames: ["api.fixture.localhost"] },
			]);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

// Only against the test run's failing `tailscale` stub: the real one would
// add Serve entries to the developer's machine.
const tailscaleStubbed =
	lookupOnPath("tailscale")?.includes("buncargo-test-runtimes-") === true;

describe("activateNamedHosts in tailscale mode", () => {
	it.skipIf(!tailscaleStubbed)(
		"keeps the plain URLs, with the warning dev --detach repeats, when Tailscale is unreachable",
		async () => {
			const switches: boolean[] = [];
			const env = {
				root,
				ports: { web: 3100, api: 3200 },
				hosts: { ...hosts(false), mode: "tailscale" },
				setNamedHostsActive: (active: boolean) => switches.push(active),
			} as unknown as DevEnvironment<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			const warnings = await activateNamedHosts(
				env,
				{ enabled: true },
				readyMachine(),
			);

			expect(switches).toEqual([false]);
			expect(namedHostsFallbacks(warnings.join("\n"))).toEqual([
				expect.stringContaining("Tailscale is not reachable"),
			]);
		},
	);
});
