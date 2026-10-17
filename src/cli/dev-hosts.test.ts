import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadHostRoutes,
	removeHostRoutes,
	upsertHostRoutes,
} from "../core/hosts";
import { lookupOnPath } from "../core/tool-binary";
import type {
	AppConfig,
	DevEnvironment,
	HostsRuntime,
	ServiceConfig,
} from "../types";
import { namedHostsFallbacks } from "./dev-detach";
import { activateNamedHosts, reclaimAppRoute } from "./dev-hosts";

// The routes registry lives in ~/.buncargo: never the developer's.
const savedHome = process.env.HOME;
let home = "";
let root = "";
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-reclaim-home-"));
	root = mkdtempSync(join(tmpdir(), "buncargo-reclaim-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
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

describe("reclaimAppRoute", () => {
	// Run B took `web` over from this run, so the route moved to B; B exited
	// and released it, and `web` restarted here.
	it("claims a restarted app's route back after the run that took it over ended", async () => {
		const other = process.ppid;
		await upsertHostRoutes([
			{
				hostname: "web.fixture.localhost",
				port: 3100,
				kind: "app",
				name: "web",
				root,
				pid: other,
				updatedAt: new Date().toISOString(),
			},
		]);

		// While that run lives, the route stays its own.
		await reclaimAppRoute({ root, hosts: hosts(true) }, "web");
		expect((await loadHostRoutes()).map((route) => route.pid)).toEqual([other]);

		await removeHostRoutes((route) => route.pid === other);
		await reclaimAppRoute({ root, hosts: hosts(true) }, "web");
		expect(await loadHostRoutes()).toMatchObject([
			{ hostname: "web.fixture.localhost", port: 3100, pid: process.pid },
		]);
	});

	it("claims nothing while named hosts are not serving this run", async () => {
		await reclaimAppRoute({ root, hosts: hosts(false) }, "web");
		await reclaimAppRoute({ root, hosts: null }, "web");
		expect(await loadHostRoutes()).toEqual([]);
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

			const warnings = await activateNamedHosts(env, { enabled: true });

			expect(switches).toEqual([false]);
			expect(namedHostsFallbacks(warnings.join("\n"))).toEqual([
				expect.stringContaining("Tailscale is not reachable"),
			]);
		},
	);
});
