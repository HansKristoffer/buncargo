import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSupervision } from "./app-supervision";
import { isProcessAlive } from "./lifecycle";

function child() {
	return spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
}

it("keeps supervision alive across replacement of its last child", async () => {
	const session = new AppSupervision({ width: 1 });
	let replacementPid: number | undefined;
	try {
		await session.register("worker", child(), true, false, false);
		const first = session.pids.worker;
		const watching = session.owner.wait().catch(() => {});
		session.setSpawner("worker", async () => child(), true, false);
		await session.restart("worker");
		replacementPid = session.pids.worker;
		if (replacementPid === undefined)
			throw new Error("Replacement did not have a pid");
		expect(replacementPid).not.toBe(first);
		expect(session.owner.controller.signal.aborted).toBe(false);
		expect(isProcessAlive(replacementPid)).toBe(true);
		await session.stop();
		await watching;
		expect(isProcessAlive(replacementPid)).toBe(false);
	} finally {
		await session.stop();
	}
});

it("never respawns a child when stop arrives while it is being retired", async () => {
	const session = new AppSupervision({ width: 1 });
	let spawns = 0;
	try {
		await session.register("worker", child(), true, false, false);
		session.setSpawner(
			"worker",
			async () => {
				spawns++;
				return child();
			},
			true,
			false,
		);
		const replacing = session.restart("worker").catch(() => {});
		await session.stop();
		await replacing;
		expect(spawns).toBe(0);
		const pid = session.pids.worker;
		if (pid === undefined) throw new Error("Worker did not have a pid");
		expect(isProcessAlive(pid)).toBe(false);
	} finally {
		await session.stop();
	}
});

it("adopts detached listeners after replacements and warns once per app", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-restart-detached-"));
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = Number(probe.port);
	probe.stop(true);
	const marker = join(root, "ready");
	const adopted: number[] = [];
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message) => warnings.push(String(message));
	const session = new AppSupervision({
		width: 1,
		onAppAdopted: (_name, app) => adopted.push(app.pid),
	});
	try {
		await Bun.write(
			join(root, "listener.ts"),
			`Bun.serve({ port: ${port}, fetch: () => new Response("ok") }); await Bun.write(${JSON.stringify(marker)}, "ready");`,
		);
		await Bun.write(
			join(root, "parent.ts"),
			`import { spawn } from "node:child_process"; const app = spawn(process.execPath, ["listener.ts"], { detached: true, stdio: "ignore" }); app.unref(); while (!(await Bun.file(${JSON.stringify(marker)}).exists())) await Bun.sleep(10);`,
		);
		await session.register("web", child(), false, false, false, port);
		session.setSpawner(
			"web",
			async () => {
				await rm(marker, { force: true });
				return spawn(process.execPath, ["parent.ts"], {
					cwd: root,
					detached: true,
					stdio: "ignore",
				});
			},
			false,
			false,
			port,
		);
		for (const count of [1, 2]) {
			await session.restart("web");
			const deadline = Date.now() + 5000;
			while (adopted.length < count && Date.now() < deadline)
				await Bun.sleep(20);
			expect(adopted).toHaveLength(count);
			expect(session.pids.web).toBe(adopted[count - 1]);
			expect((await fetch(`http://localhost:${port}`)).status).toBe(200);
		}
		expect(
			warnings.filter((line) => line.includes("the app detached")),
		).toHaveLength(1);
		await session.stop();
		await expect(fetch(`http://localhost:${port}`)).rejects.toThrow();
	} finally {
		await session.stop();
		console.warn = originalWarn;
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
