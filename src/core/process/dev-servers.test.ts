import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeInfisical } from "../secrets/fake-infisical.testing";
import { clearScopeSecretsCache } from "../secrets/infisical";
import { startDevServers, stopDevServers } from "./dev-servers";
import { signalProcessTree } from "./port-owner";

describe("startDevServers", () => {
	it("skips healthEndpoint: false / devCommand: false and honors attach", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-process-"));
		const basePort = 45100 + Math.floor(Math.random() * 200);
		const skipPort = basePort;
		const silentPort = basePort + 1;
		const attachPort = basePort + 2;
		const marker = join(root, "attached.txt");
		let silentPid: number | undefined;

		try {
			const pids = await startDevServers(
				{
					skipped: { port: skipPort, devCommand: false },
					silent: {
						port: silentPort,
						healthEndpoint: false,
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
				},
				root,
				{},
				{ skipped: skipPort, silent: silentPort },
				{ verbose: false, waitForExit: false },
			);

			expect(pids.skipped).toBeUndefined();
			expect(typeof pids.silent).toBe("number");
			silentPid = pids.silent;

			await startDevServers(
				{
					app: {
						port: attachPort,
						healthEndpoint: false,
						devCommand: `bun -e ${JSON.stringify(`await Bun.write(${JSON.stringify(marker)}, process.argv[1] ?? "")`)}`,
					},
				},
				root,
				{},
				{ app: attachPort },
				{
					verbose: false,
					attach: "app",
					extraArgs: ["from-attach"],
					waitForExit: true,
					waitForHealth: async () => {},
				},
			);

			expect(await Bun.file(marker).text()).toBe("from-attach");
		} finally {
			if (silentPid) {
				signalProcessTree(silentPid, "SIGTERM");
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});

/**
 * The injection used to live in `startAppServers`, which `buncargo dev` does
 * not call — it spawns through `startDevServers` itself, so the whole feature
 * was dead code for the CLI. Asserting it at this function is the point: it is
 * the one both spawn paths share.
 */
describe("startDevServers secret injection", () => {
	it("injects an app's Infisical secrets under its computed env", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-secrets-spawn-"));
		const savedHome = process.env.HOME;
		const savedPath = process.env.BUNCARGO_INFISICAL_PATH;
		const infisical = startFakeInfisical();
		infisical.projects.p1 = {
			secrets: { OPENAI_API_KEY: "sk-project", PORT: "9999", BLANK: "" },
		};
		process.env.HOME = infisical.home;
		process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
		const marker = join(root, "env.json");
		const port = 45400 + Math.floor(Math.random() * 200);
		const secrets = { projectId: "p1", siteUrl: infisical.siteUrl };

		try {
			await startDevServers(
				{
					api: {
						port,
						healthEndpoint: false,
						devCommand: `bun -e ${JSON.stringify(
							`await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ secret: process.env.OPENAI_API_KEY ?? null, port: process.env.PORT ?? null, blank: process.env.BLANK ?? null }))`,
						)}`,
						secrets,
					},
				},
				root,
				{ api: { PORT: String(port) } },
				{ api: port },
				{
					verbose: false,
					waitForExit: true,
					waitForHealth: async () => {},
				},
			);

			expect(JSON.parse(await Bun.file(marker).text())).toEqual({
				secret: "sk-project",
				// The computed env wins over a key of the same name.
				port: String(port),
				// An empty export is left out, so the app's own loader still fetches.
				blank: null,
			});

			// A required key nobody provides stops the run before anything spawns.
			await expect(
				startDevServers(
					{
						api: {
							port,
							healthEndpoint: false,
							devCommand: "exit 0",
							secrets: {
								...secrets,
								required: ["OPENAI_API_KEY", "STRIPE_KEY"],
							},
						},
					},
					root,
					{},
					{ api: port },
					{ verbose: false, waitForExit: true, waitForHealth: async () => {} },
				),
			).rejects.toThrow("api: STRIPE_KEY");
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
			else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
			clearScopeSecretsCache();
			infisical.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers ordering, prebuild and captures", () => {
	it("starts after health, prebuilds first, and restarts on a capture", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-order-"));
		const apiPort = 45400 + Math.floor(Math.random() * 200);
		const log = join(root, "events.log");
		const append = (line: string) =>
			`bun -e ${JSON.stringify(`require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${line}\n`)})`)}`;
		const captures: string[] = [];
		let pids: Record<string, number> = {};

		try {
			pids = await startDevServers(
				{
					api: {
						port: apiPort,
						devCommand: `${append("api spawned")} && bun -e 'Bun.serve({ port: ${apiPort}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000)'`,
					},
					// Would log "api down" if it spawned before api answered.
					web: {
						kind: "worker",
						startAfter: ["api"],
						devCommand: `bun -e 'fetch("http://localhost:${apiPort}/").then(() => require("node:fs").appendFileSync(${JSON.stringify(log)}, "web saw api\\n"), () => require("node:fs").appendFileSync(${JSON.stringify(log)}, "api down\\n")); setInterval(() => {}, 60000)'`,
					},
					ext: {
						kind: "worker",
						prebuild: append("ext prebuilt"),
						// Printed after a pause: an app that has not spawned yet gets the
						// new value anyway, so only a running one is restarted.
						devCommand: `${append("ext spawned")} && sleep 1 && echo 'Using URL: https://one.example/api/rpc' && sleep 60`,
						captures: {
							url: { pattern: /Using URL:\s*(\S+)/, as: "publicUrl" },
						},
					},
					dependent: {
						kind: "worker",
						restartOn: ["captured.url"],
						devCommand: `${append("dependent spawned")} && sleep 60`,
					},
				},
				root,
				{},
				{ api: apiPort },
				{
					verbose: false,
					waitForExit: false,
					onCapture: (app, captured) => {
						captures.push(`${app}:${captured.name}=${captured.value}`);
						return ["captured.url"];
					},
				},
			);

			const deadline = Date.now() + 10_000;
			const events = async () =>
				(await Bun.file(log).exists())
					? (await Bun.file(log).text()).split("\n")
					: [];
			while (
				Date.now() < deadline &&
				(await events()).filter((line) => line === "dependent spawned").length <
					2
			) {
				await Bun.sleep(50);
			}
			const lines = await events();

			expect(lines).toContain("web saw api");
			expect(lines).not.toContain("api down");
			expect(lines.indexOf("ext prebuilt")).toBeLessThan(
				lines.indexOf("ext spawned"),
			);
			expect(captures).toEqual(["ext:url=https://one.example"]);
			// Spawned once, then again when the value it restarts on arrived.
			expect(lines.filter((line) => line === "dependent spawned")).toHaveLength(
				2,
			);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});
