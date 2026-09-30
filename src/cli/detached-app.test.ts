import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signalProcessTree } from "../core/process/port-owner";

for (const stop of ["command", "SIGINT"] as const) {
	it(`publishes a detached app as ready and cleans it up through ${stop}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-detached-cli-"));
		const cli = resolve(import.meta.dir, "bin.ts");
		await Bun.write(
			join(root, "package.json"),
			JSON.stringify({ name: "detached-test", private: true }),
		);
		const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const port = Number(probe.port);
		probe.stop(true);
		const marker = join(root, "child.pid");
		const env = {
			...process.env,
			HOME: root,
			CI: "1",
			BUNCARGO_PORT_OFFSET: "0",
			BUNCARGO_HOSTS: "0",
			DOCKER_HOST: "unix:///nonexistent-buncargo-test.sock",
		};
		await Bun.write(
			join(root, "child.ts"),
			`Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("ok")}); await Bun.write(${JSON.stringify(marker)}, String(process.pid));`,
		);
		await Bun.write(
			join(root, "parent.ts"),
			`import {spawn} from "node:child_process"; const child = spawn(process.execPath, ["child.ts"], {detached: true, stdio: "ignore"}); child.unref(); while (!(await Bun.file(${JSON.stringify(marker)}).exists())) await Bun.sleep(10);`,
		);
		await Bun.write(
			join(root, "dev.config.ts"),
			`export default ${JSON.stringify({ projectPrefix: "detached-test", services: {}, apps: { app: { port, devCommand: `${process.execPath} parent.ts`, requiredServices: [] } }, options: { worktreeIsolation: false, hosts: false } })};`,
		);
		const child = Bun.spawn([process.execPath, cli, "dev", "--no-hosts"], {
			cwd: root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = new Response(child.stdout).text();
		const errors = new Response(child.stderr).text();
		let detachedPid: number | undefined;
		try {
			const deadline = Date.now() + 10000;
			let app:
				| { pid: number; status: string; processIdentity: string }
				| undefined;
			while (Date.now() < deadline) {
				if (await Bun.file(marker).exists())
					detachedPid = Number(await Bun.file(marker).text());
				const file = Bun.file(join(root, ".buncargo", "runs.json"));
				if (await file.exists()) {
					const registry = await file.json();
					app = registry.runs?.[0]?.apps?.[0];
					if (app?.pid === detachedPid && app?.status === "ready") break;
				}
				if (child.exitCode !== null)
					throw new Error((await output) + (await errors));
				await Bun.sleep(25);
			}
			const runs = Bun.spawn([process.execPath, cli, "runs", "--json"], {
				cwd: root,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const listedRun = JSON.parse(await new Response(runs.stdout).text())
				.runs[0];
			const listed = listedRun.apps[0];
			expect(await runs.exited).toBe(0);
			expect(listed.pid).toBe(detachedPid);
			expect(listed.status).toBe("ready");
			expect(listed.processIdentity).toStartWith("v2:");
			if (stop === "command") {
				const stopped = Bun.spawn(
					[process.execPath, cli, "stop", "app", "--root", listedRun.root],
					{ cwd: root, env, stdout: "ignore", stderr: "pipe" },
				);
				expect(await stopped.exited).toBe(0);
			} else child.kill("SIGINT");
			await Promise.race([
				child.exited,
				Bun.sleep(10000).then(() => {
					throw new Error("Run did not stop");
				}),
			]);
			await expect(fetch(`http://localhost:${port}`)).rejects.toThrow();
			expect((await output) + (await errors)).toContain(
				"the app detached from buncargo; it will be stopped with the run",
			);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			if (detachedPid) {
				try {
					signalProcessTree(detachedPid, "SIGKILL");
				} catch {}
			}
			await rm(root, { recursive: true, force: true });
		}
	}, 25000);
}
