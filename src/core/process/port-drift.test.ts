import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApps } from "../../config/resolve";
import { isTcpPortOpen } from "../network";
import { freePorts } from "../test-env.testing";
import { startDevServers } from "./dev-servers";
import {
	checkPortDrift,
	type DriftProbe,
	driftedPorts,
	systemDriftProbe,
	watchPortDrift,
} from "./port-drift";
import { emptyListenerSnapshot } from "./port-snapshot";

function listeners(entries: Record<number, number[]>) {
	const snapshot = emptyListenerSnapshot();
	for (const [port, pids] of Object.entries(entries))
		snapshot.pidsByPort.set(Number(port), pids);
	return snapshot;
}

const marketing = { name: "marketing", pid: 100, port: 8021 };

describe("driftedPorts", () => {
	it("lists the tree's other ports and ignores everyone else's", () => {
		const snapshot = listeners({ 8021: [7], 8022: [101], 9000: [55] });
		expect(driftedPorts(marketing, snapshot, [100, 101])).toEqual([8022]);
	});
});

describe("checkPortDrift", () => {
	const probe = (holder: boolean, tree: number[]): DriftProbe => ({
		listeners: async () => listeners({ 8022: [101], 9229: [100] }),
		foreignHolder: async () => (holder ? { kind: "unidentified" } : null),
		processTree: () => tree,
	});

	it("names the drift when the assigned port is someone else's", async () => {
		const drift = await checkPortDrift(
			[marketing],
			probe(true, [100, 101]),
			new AbortController().signal,
		);
		expect(drift?.name).toBe("marketing");
		const message = drift?.message;
		expect(message).toContain("marketing listens on :8022, :9229");
		expect(message).toContain("not its assigned :8021");
		expect(message).toContain("unidentified process");
	});

	it("stays quiet while the assigned port is free: an inspector port is not drift", async () => {
		expect(
			await checkPortDrift(
				[marketing],
				probe(false, [100, 101]),
				new AbortController().signal,
			),
		).toBeUndefined();
	});

	it("resolves once aborted, having reported nothing", async () => {
		const controller = new AbortController();
		const drifted: string[] = [];
		const watching = watchPortDrift(
			() => [marketing],
			probe(false, []),
			controller.signal,
			(name) => drifted.push(name),
		);
		controller.abort();
		await expect(watching).resolves.toBeUndefined();
		expect(drifted).toEqual([]);
	});
});

describe("systemDriftProbe", () => {
	it("names an app listening off its port while another process holds it", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-drift-"));
		const [assigned, drifted] = freePorts(2);
		// What Astro does when it finds :8021 held by a system service: the app
		// takes the next port, and something foreign holds its own.
		const app = Bun.spawn(
			[
				process.execPath,
				"-e",
				`Bun.serve({ port: ${drifted}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000)`,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		const holder = Bun.listen({
			hostname: "127.0.0.1",
			port: assigned,
			socket: { data() {} },
		});
		try {
			const deadline = performance.now() + 10_000;
			while (!(await isTcpPortOpen(drifted, "127.0.0.1", 200))) {
				if (performance.now() > deadline) throw new Error("app never listened");
				await Bun.sleep(20);
			}
			const drift = await checkPortDrift(
				[{ name: "marketing", pid: app.pid, port: assigned }],
				systemDriftProbe({ root, projectName: "demo" }),
				new AbortController().signal,
			);
			expect(drift?.message).toContain(
				`marketing listens on :${drifted}, not its assigned :${assigned}`,
			);
		} finally {
			holder.stop(true);
			app.kill("SIGKILL");
			await app.exited;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers port drift", () => {
	it("fails an app that drifted off its port instead of waiting out its health timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-drift-"));
		const [assigned, drifted] = freePorts(2);
		// The app answers on no port, so only the drift report can end its
		// readiness check before the health timeout.
		const probe: DriftProbe = {
			listeners: async () => {
				const snapshot = emptyListenerSnapshot();
				snapshot.pidsByPort.set(drifted, [appPid ?? -1]);
				return snapshot;
			},
			foreignHolder: async () => ({ kind: "unidentified" }),
			processTree: (pid) => [pid],
		};
		let appPid: number | undefined;
		try {
			const run = startDevServers(
				resolveApps({
					marketing: {
						port: assigned,
						healthTimeout: 60_000,
						devCommand: "sleep 60",
					},
				}),
				root,
				{},
				{ marketing: assigned },
				{
					verbose: false,
					waitForExit: false,
					portDrift: probe,
					onAppPhase: (_name, life) => {
						appPid ??= life.pid;
					},
				},
			);
			await expect(run).rejects.toThrow(
				`marketing listens on :${drifted}, not its assigned :${assigned}`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
