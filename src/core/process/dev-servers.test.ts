import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServers } from "./dev-servers";
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

describe("startDevServers supervision", () => {
	/**
	 * Apps are spawned in a loop and supervised only once the wave is up, so an
	 * app that dies in between emits its `close` before anything is listening.
	 * That event is gone for good; the run used to wait forever for a process
	 * that was never coming back, with nothing printed to say so.
	 */
	it("notices an app that exited before supervision started", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-early-exit-"));
		const port = 45600 + Math.floor(Math.random() * 200);
		const exits: Array<[string, number | null]> = [];

		try {
			await startDevServers(
				{
					quick: {
						port,
						devCommand: "bun -e 'process.exit(0)'",
						healthEndpoint: false,
					},
				},
				root,
				{},
				{ quick: port },
				{
					verbose: false,
					waitForExit: true,
					// Long enough that a lost `close` event shows up as a timeout
					// rather than as a pass.
					waitForHealth: async () => {
						await new Promise((resolve) => setTimeout(resolve, 300));
					},
					onAppExit: (name, code) => exits.push([name, code]),
				},
			);
			expect(exits).toEqual([["quick", 0]]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("fails the run when an app exits non-zero before supervision", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-early-fail-"));
		const port = 45800 + Math.floor(Math.random() * 200);

		try {
			await expect(
				startDevServers(
					{
						broken: {
							port,
							devCommand: "bun -e 'process.exit(3)'",
							healthEndpoint: false,
						},
					},
					root,
					{},
					{ broken: port },
					{
						verbose: false,
						waitForExit: true,
						waitForHealth: async () => {
							await new Promise((resolve) => setTimeout(resolve, 300));
						},
					},
				),
			).rejects.toThrow(/exited with code 3/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
});
