import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { resolveApp, resolveApps } from "../config/resolve";
import { isPortInUse } from "../core/process";
import { stopRunningApps, takeoverCandidates } from "./takeover";

describe("takeoverCandidates", () => {
	const ports = { api: 3000, web: 5173, worker: 4000 };

	it("keeps a reused app this run could serve itself", () => {
		const reused = resolveApps({
			api: { port: 3000, devCommand: "bun run dev" },
		});
		expect(takeoverCandidates(reused, ports).names).toEqual(["api"]);
	});

	it("skips an app buncargo does not spawn", () => {
		// Stopping its port would leave it down rather than move it here.
		const reused = resolveApps({
			worker: { port: 4000, devCommand: false },
		});
		expect(takeoverCandidates(reused, ports).names).toEqual([]);
	});

	it("skips an app with no allocated port", () => {
		const reused = resolveApps({
			ghost: { port: 9999, devCommand: "bun run dev" },
		});
		expect(takeoverCandidates(reused, ports).names).toEqual([]);
	});

	it("carries the app config through for the spawner", () => {
		const api = resolveApp({ port: 3000, devCommand: "bun run dev" });
		expect(takeoverCandidates({ api }, ports).apps.api).toBe(api);
	});
});

describe("stopRunningApps", () => {
	it("frees a port held by another dev server", async () => {
		const port = 39871;
		const child = spawn(
			"bun",
			["-e", `Bun.serve({ port: ${port}, fetch: () => new Response("hi") })`],
			{ detached: true, stdio: "ignore" },
		);
		try {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && !isPortInUse(port)) {
				await Bun.sleep(50);
			}
			expect(isPortInUse(port)).toBe(true);

			expect(await stopRunningApps(["api"], { api: port })).toEqual(["api"]);

			expect(isPortInUse(port)).toBe(false);
		} finally {
			try {
				if (child.pid) process.kill(child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	});

	it("reports nothing when the other run already exited", async () => {
		expect(await stopRunningApps(["api"], { api: 39872 })).toEqual([]);
	});
});
