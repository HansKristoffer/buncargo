import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { freePorts } from "../test-env.testing";
import { collectProcessTree, createPortOwnerSnapshotAsync } from "./port-owner";
import {
	parseProcNetTcp,
	readListenerSnapshot,
	readListenerSnapshotAsync,
	readProcessCwds,
	readProcessCwdsAsync,
} from "./port-snapshot";

describe("parseProcNetTcp", () => {
	const sample = [
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 00000000 100 0 0 10 0",
		"   1: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 00000000 100 0 0 10 0",
		"   2: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1 00000000 100 0 0 10 0",
		"   3: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 00000000 100 0 0 10 0",
	].join("\n");

	it("keeps only TCP_LISTEN (0A) sockets with nonzero inodes", () => {
		const map = parseProcNetTcp(sample);
		// 0x0BB8 = 3000, 0x1538 = 5432; 0x1435 is ESTABLISHED (01); 0x0016 has inode 0.
		expect([...map.entries()]).toEqual([
			[3000, ["12345"]],
			[5432, ["54321"]],
		]);
	});

	it("filters to wanted ports when a set is supplied", () => {
		const map = parseProcNetTcp(sample, new Set([5432]));
		expect([...map.entries()]).toEqual([[5432, ["54321"]]]);
	});
});

describe("port-snapshot live introspection", () => {
	it("finds a real listening socket and resolves its pid, command and cwd", async () => {
		const [port] = freePorts(1);
		if (!port) throw new Error("expected free port");

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: () => new Response("ok"),
		});
		try {
			const asyncSnap = await readListenerSnapshotAsync(undefined, [port]);
			expect(asyncSnap.pidsByPort.get(port)).toContain(process.pid);
			expect(asyncSnap.commandByPid.get(process.pid)).toBeTruthy();

			const syncSnap = readListenerSnapshot([port]);
			expect(syncSnap.pidsByPort.get(port)).toContain(process.pid);

			const cwdsAsync = await readProcessCwdsAsync([process.pid]);
			expect(cwdsAsync.get(process.pid)).toBe(process.cwd());

			const cwdsSync = readProcessCwds([process.pid]);
			expect(cwdsSync.get(process.pid)).toBe(process.cwd());
		} finally {
			server.stop(true);
		}
	});

	it("collects child processes in collectProcessTree", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 60000)"],
			{
				stdio: "ignore",
			},
		);
		try {
			const deadline = Date.now() + 2000;
			let tree: number[] = [];
			while (Date.now() < deadline) {
				tree = collectProcessTree(process.pid);
				if (child.pid && tree.includes(child.pid)) break;
				await Bun.sleep(10);
			}
			expect(tree).toContain(process.pid);
			if (child.pid) expect(tree).toContain(child.pid);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("skips host listener reading when supplied containers already cover every asked port", async () => {
		const postgres = {
			id: "c1",
			name: "app-postgres-1",
			composeProject: "app",
			runtime: "docker" as const,
		};
		const containers = new Map([[5432, postgres]]);
		const snapshot = await createPortOwnerSnapshotAsync({
			ports: [5432],
			containers,
		});
		expect(snapshot.isBusy(5432)).toBe(true);
		expect(snapshot.owner(5432)).toEqual({
			kind: "container",
			container: postgres,
		});
	});

	it("still resolves a busy port outside cwdPorts when ports is left open", async () => {
		const [hintPort, probePort] = freePorts(2);
		if (!hintPort || !probePort) throw new Error("expected free ports");

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: probePort,
			fetch: () => new Response("ok"),
		});
		try {
			const snapshot = await createPortOwnerSnapshotAsync({
				cwdPorts: [hintPort],
				skipContainers: true,
			});
			expect(snapshot.isBusy(hintPort)).toBe(false);
			expect(snapshot.isBusy(probePort)).toBe(true);
			const owner = snapshot.owner(probePort);
			expect(owner?.kind).toBe("process");
			if (owner?.kind === "process") {
				expect(owner.pids).toContain(process.pid);
				expect(owner.cwd).toBe(process.cwd());
			}
		} finally {
			server.stop(true);
		}
	});
});
