import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../process/lifecycle";
import {
	parseQuickTunnelUrlFromOutput,
	startCloudflaredTunnel,
} from "./cloudflared-process";

describe("parseQuickTunnelUrlFromOutput", () => {
	it("parses URL from ASCII box pipe line", () => {
		const log = `
2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+
2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
2024-01-01T00:00:00Z INF |  https://foo-bar-baz.trycloudflare.com                                                    |
2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+
`;
		expect(parseQuickTunnelUrlFromOutput(log)).toBe(
			"https://foo-bar-baz.trycloudflare.com",
		);
	});

	it("parses trycloudflare URL without relying on the pipe prefix", () => {
		const log = `some noise https://x.trycloudflare.com/path more`;
		expect(parseQuickTunnelUrlFromOutput(log)).toBe(
			"https://x.trycloudflare.com",
		);
	});
});

const LOCAL_URL = "http://localhost:3000";

describe("cloudflared process ownership", () => {
	const dirs: string[] = [];
	const tunnels: ReturnType<typeof startCloudflaredTunnel>[] = [];
	afterEach(async () => {
		await Promise.allSettled(tunnels.splice(0).map((tunnel) => tunnel.close()));
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});
	/** A stand-in cloudflared that ignores SIGTERM and records its pid. */
	function fixture(output = "") {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tunnel-child-"));
		dirs.push(dir);
		const path = join(dir, "cloudflared");
		const pidfile = join(dir, "pid");
		writeFileSync(
			path,
			`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidfile)}, String(process.pid));\nprocess.on("SIGTERM", () => {});\n${output}\nsetInterval(() => {}, 1000);\n`,
		);
		chmodSync(path, 0o755);
		return path;
	}
	function stubPid(binary: string): number | undefined {
		const pidfile = join(binary, "..", "pid");
		return existsSync(pidfile)
			? Number(readFileSync(pidfile, "utf8"))
			: undefined;
	}
	async function until(condition: () => boolean, timeoutMs = 5000) {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error("condition not met in time");
			await Bun.sleep(20);
		}
	}
	it("terminates a child ignoring TERM before reporting URL timeout", async () => {
		const tunnel = startCloudflaredTunnel(LOCAL_URL, {
			binary: fixture(),
			timeoutMs: 100,
			graceMs: 60,
		});
		tunnels.push(tunnel);
		await expect(tunnel.url).rejects.toThrow("timed out");
		expect(tunnel.child.pid && isProcessAlive(tunnel.child.pid)).toBe(false);
	});
	it("cancels URL startup and waits for owned child termination", async () => {
		const controller = new AbortController();
		const tunnel = startCloudflaredTunnel(LOCAL_URL, {
			binary: fixture(),
			signal: controller.signal,
			graceMs: 60,
		});
		tunnels.push(tunnel);
		setTimeout(() => controller.abort(new Error("cancelled")), 50);
		await expect(tunnel.url).rejects.toThrow("cancelled");
		expect(tunnel.child.pid && isProcessAlive(tunnel.child.pid)).toBe(false);
	});
	it("closes a ready tunnel idempotently with confirmed exit", async () => {
		const tunnel = startCloudflaredTunnel(LOCAL_URL, {
			binary: fixture('console.log("https://fixture.trycloudflare.com");'),
			graceMs: 60,
		});
		tunnels.push(tunnel);
		expect(await tunnel.url).toBe("https://fixture.trycloudflare.com");
		await Promise.all([tunnel.close(), tunnel.close()]);
		expect(tunnel.child.pid && isProcessAlive(tunnel.child.pid)).toBe(false);
	});
	it("stops cloudflared itself, not only its guard, on close", async () => {
		const binary = fixture('console.log("https://fixture.trycloudflare.com");');
		const tunnel = startCloudflaredTunnel(LOCAL_URL, { binary, graceMs: 60 });
		tunnels.push(tunnel);
		await tunnel.url;
		const pid = stubPid(binary);
		expect(pid && isProcessAlive(pid)).toBe(true);
		await tunnel.close();
		expect(pid && isProcessAlive(pid)).toBe(false);
	});
	// SIGKILL runs no handler of ours, so only the guard's stdin closing can
	// take cloudflared down; spawned detached on its own, it kept the tunnel open.
	it("takes cloudflared down when buncargo is hard-killed", async () => {
		const binary = fixture();
		const script = join(binary, "..", "run.ts");
		writeFileSync(
			script,
			`import { startCloudflaredTunnel } from ${JSON.stringify(join(import.meta.dir, "cloudflared-process.ts"))};
startCloudflaredTunnel("http://localhost:3000", { binary: ${JSON.stringify(binary)}, timeoutMs: 0 }).url.catch(() => {});
setInterval(() => {}, 1000);`,
		);
		const parent = spawn(process.execPath, [script], { stdio: "ignore" });
		const exited = new Promise<void>((resolve) =>
			parent.once("exit", () => resolve()),
		);
		let pid: number | undefined;
		try {
			await until(() => stubPid(binary) !== undefined);
			pid = stubPid(binary);
			expect(pid && isProcessAlive(pid)).toBe(true);
			parent.kill("SIGKILL");
			await exited;
			await until(() => !(pid && isProcessAlive(pid)));
		} finally {
			parent.kill("SIGKILL");
			if (pid && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 10_000);
	it("keeps the connect tokens out of cloudflared's environment", async () => {
		const saved = process.env.BUNCARGO_CONNECT_TOKENS;
		process.env.BUNCARGO_CONNECT_TOKENS = "bc_share_secret";
		try {
			const tunnel = startCloudflaredTunnel(LOCAL_URL, {
				binary: fixture(
					'console.log("https://" + (process.env.BUNCARGO_CONNECT_TOKENS ? "leaked" : "clean") + ".trycloudflare.com");',
				),
				graceMs: 60,
			});
			tunnels.push(tunnel);
			expect(await tunnel.url).toBe("https://clean.trycloudflare.com");
		} finally {
			if (saved === undefined) delete process.env.BUNCARGO_CONNECT_TOKENS;
			else process.env.BUNCARGO_CONNECT_TOKENS = saved;
		}
	});
});
