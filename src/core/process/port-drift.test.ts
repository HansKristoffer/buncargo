import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServers } from "./dev-servers";
import {
	checkPortDrift,
	type DriftProbe,
	driftedPorts,
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
		foreignHolder: async () =>
			holder ? { pids: [], unidentified: true } : null,
		processTree: () => tree,
	});

	it("names the drift when the assigned port is someone else's", async () => {
		const message = await checkPortDrift(
			[marketing],
			probe(true, [100, 101]),
			new AbortController().signal,
		);
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

	it("resolves rather than rejects once aborted", async () => {
		const controller = new AbortController();
		const watching = watchPortDrift(
			() => [marketing],
			probe(false, []),
			controller.signal,
			5,
		);
		controller.abort();
		await expect(watching).resolves.toBeUndefined();
	});
});

describe("startDevServers port drift", () => {
	it("fails an app that drifted off its port instead of waiting out its health timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-drift-"));
		const assigned = 46100 + Math.floor(Math.random() * 300);
		const drifted = assigned + 1;
		let holder: { stop(force?: boolean): void } | undefined;
		const started = performance.now();
		try {
			// The app takes the next port, then something foreign takes its own:
			// what Astro does when it finds :8021 held by a system service.
			const run = startDevServers(
				{
					marketing: {
						port: assigned,
						healthTimeout: 30000,
						devCommand: `bun -e 'Bun.serve({ port: ${drifted}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000)'`,
					},
				},
				root,
				{},
				{ marketing: assigned },
				{ verbose: false, waitForExit: false },
			);
			await Bun.sleep(150);
			holder = Bun.listen({
				hostname: "127.0.0.1",
				port: assigned,
				socket: { data() {} },
			});
			await expect(run).rejects.toThrow(
				`marketing listens on :${drifted}, not its assigned :${assigned}`,
			);
			expect(performance.now() - started).toBeLessThan(10000);
		} finally {
			holder?.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 20000);
});
