import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalDirectory } from "../../connect-directory/local";
import { tailcatTestsEnabled } from "../runtime-flags";
import { DirectoryClient } from "./client";
import { makeSecret, parseConnectionToken } from "./protocol";
import { startTailcatPublisher } from "./tailcat/publisher";

test.skipIf(!tailcatTestsEnabled())(
	"CLI creates a private identity and its detached helper opens and disconnects a remote app",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "buncargo-connect-helper-"));
		const directory = await startLocalDirectory();
		const client = new DirectoryClient(directory.url);
		const app = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("remote worktree"),
		});
		let connector:
			| Awaited<ReturnType<typeof startTailcatPublisher>>
			| undefined;
		const cli = new URL("../../cli/bin.ts", import.meta.url).pathname;
		async function command(...args: string[]) {
			const child = Bun.spawn(
				[process.execPath, cli, "connect", ...args, "--json"],
				{
					env: {
						...process.env,
						HOME: home,
						BUNCARGO_CONNECT_DIRECTORY: directory.url,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stdout = new Response(child.stdout).text(),
				stderr = new Response(child.stderr).text();
			const timeout = setTimeout(() => child.kill(), 45000);
			try {
				if ((await child.exited) !== 0)
					throw new Error(`Connection CLI failed: ${await stderr}`);
				return JSON.parse(await stdout);
			} finally {
				clearTimeout(timeout);
			}
		}
		try {
			const { token } = await command("token");
			const recipient = parseConnectionToken(token);
			expect(
				(await stat(join(home, ".buncargo/connect-device.json"))).mode & 0o777,
			).toBe(0o600);
			const secret = makeSecret();
			connector = await startTailcatPublisher({
				targets: [
					{
						id: "web",
						name: "web",
						kind: "app",
						protocol: "http",
						status: "ready",
						port: app.port as number,
					},
				],
				signal: new AbortController().signal,
			});
			const endpoint = connector.endpoint;
			await client.publish(recipient.recipientId, recipient.secret, secret, {
				version: 1,
				sessionId: "helper-session",
				project: "remote",
				branch: "feature/helper",
				worktree: "sandbox",
				primaryApp: "web",
				endpoint,
				revision: 1,
				targets: connector.targets,
				transport: "ready",
			});
			expect((await command("status")).runs[0].branch).toBe("feature/helper");
			const { url, port } = await command(
				"open",
				"--session=helper-session",
				"--target=web",
			);
			const bootstrap = await fetch(url, { redirect: "manual" });
			expect(bootstrap.status).toBe(303);
			const cookie = bootstrap.headers
				.get("set-cookie")
				?.split(";")[0] as string;
			const root = `http://127.0.0.1:${port}`;
			expect(await (await fetch(root, { headers: { cookie } })).text()).toBe(
				"remote worktree",
			);
			await command("disconnect", "--session=helper-session", "--target=web");
			await expect(fetch(root)).rejects.toThrow();
		} finally {
			try {
				const helper = JSON.parse(
					await readFile(join(home, ".buncargo/connect-helper.json"), "utf8"),
				);
				process.kill(helper.pid, "SIGTERM");
			} catch {}
			await connector?.close();
			await app.stop(true);
			await directory.stop();
			await rm(home, { recursive: true, force: true });
		}
	},
	60000,
);
