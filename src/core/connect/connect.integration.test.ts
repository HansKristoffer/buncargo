import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { connectE2EEnabled, connectionDirectory } from "../runtime-flags";
import { sleep } from "../sleep";
import { DirectoryClient } from "./client";
import { makeSecret, relayEndpoint, type Snapshot } from "./protocol";
import { localForward } from "./transport/local-forward";
import { startRelayPublisher } from "./transport/publisher";

const exec = promisify(execFile);

test.skipIf(!connectE2EEnabled())(
	"live Worker relay, two recipients, private browser streaming and PostgreSQL",
	async () => {
		const client = new DirectoryClient(connectionDirectory() as string);
		const sessionId = crypto.randomUUID();
		const devices = [0, 1].map(() => ({
			id: crypto.randomUUID(),
			owner: makeSecret(),
			token: makeSecret(),
			publisher: makeSecret(),
		}));
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === "/events")
					return new Response(
						new ReadableStream({
							async start(c) {
								c.enqueue(new TextEncoder().encode("data: first\n\n"));
								await sleep(200);
								c.enqueue(new TextEncoder().encode("data: second\n\n"));
								c.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				return Response.json({ branch: "feature/live-connect", private: true });
			},
		});
		const reserve = createServer();
		reserve.listen(0, "127.0.0.1");
		await once(reserve, "listening");
		const pgPort = (reserve.address() as { port: number }).port;
		await new Promise<void>((resolve) => reserve.close(() => resolve()));
		const dir = await mkdtemp(join(tmpdir(), "buncargo-connect-pg-"));
		const targets: Snapshot["targets"] = [
			{
				id: "web",
				kind: "app",
				name: "web",
				protocol: "http",
				status: "ready",
			},
			{
				id: "db",
				kind: "service",
				name: "db",
				protocol: "tcp",
				status: "ready",
				preset: "postgres",
			},
		];
		const publishers: ReturnType<typeof startRelayPublisher>[] = [];
		const forwards: Awaited<ReturnType<typeof localForward>>[] = [];
		let postgres = false;
		try {
			await exec("initdb", [
				"-D",
				dir,
				"-U",
				"buncargo",
				"--auth=trust",
				"--no-locale",
			]);
			await exec("pg_ctl", [
				"-D",
				dir,
				"-l",
				join(dir, "server.log"),
				"-o",
				`-h 127.0.0.1 -p ${pgPort} -k ${dir}`,
				"-w",
				"start",
			]);
			postgres = true;

			const snapshot: Snapshot = {
				version: 1,
				sessionId,
				project: "buncargo-acceptance",
				branch: "feature/live-connect",
				worktree: "isolated-test",
				primaryApp: "web",
				endpoint: "",
				revision: 1,
				targets,
			};
			for (const d of devices) {
				await client.create(d.id, d.owner, d.token);
				await client.publish(d.id, d.token, d.publisher, {
					...snapshot,
					endpoint: relayEndpoint(client.origin, d.id, sessionId),
				});
				const publisher = startRelayPublisher({
					endpoint: relayEndpoint(client.origin, d.id, sessionId),
					recipient: d.id,
					session: sessionId,
					secret: d.publisher,
					origin: client.origin,
					key: await client.key(),
					targets: [
						{ id: "web", port: upstream.port as number, status: "ready" },
						{ id: "db", port: pgPort, status: "ready" },
					],
					signal: new AbortController().signal,
				});
				publishers.push(publisher);
				await publisher.ready;
				expect((await client.list(d.id, d.owner)).runs[0].branch).toBe(
					"feature/live-connect",
				);
			}
			for (const d of devices) {
				const f = await localForward(
					relayEndpoint(client.origin, d.id, sessionId),
					targets[0],
					() => client.access(d.id, d.owner, sessionId, "web"),
				);
				forwards.push(f);
				const bootstrap = await fetch(f.url, { redirect: "manual" });
				const cookie = bootstrap.headers
					.get("set-cookie")
					?.split(";")[0] as string;
				const root = `http://127.0.0.1:${f.port}`;
				let response: Response | undefined;
				for (let attempt = 0; attempt < 15; attempt++) {
					response = await fetch(root, { headers: { cookie } });
					if (response.ok) break;
					await response.body?.cancel();
					await sleep(2000);
				}
				expect(response?.status).toBe(200);
				expect(await response?.json()).toEqual({
					branch: "feature/live-connect",
					private: true,
				});
				const events = await fetch(`${root}/events`, { headers: { cookie } });
				expect(await events.text()).toBe("data: first\n\ndata: second\n\n");
				expect(
					(
						await fetch(root, {
							headers: { cookie, origin: "https://untrusted.example" },
						})
					).status,
				).toBe(403);
			}
			const d = devices[0];
			const db = await localForward(
				relayEndpoint(client.origin, d.id, sessionId),
				targets[1],
				() => client.access(d.id, d.owner, sessionId, "db"),
			);
			forwards.push(db);
			const result = await exec(
				"psql",
				[
					"-h",
					"127.0.0.1",
					"-p",
					String(db.port),
					"-U",
					"buncargo",
					"-d",
					"postgres",
					"-v",
					"ON_ERROR_STOP=1",
					"-Atc",
					"BEGIN; CREATE TEMP TABLE data AS SELECT generate_series(1,10000) AS n; SELECT sum(n) FROM data; COMMIT;",
				],
				{ timeout: 30000 },
			);
			expect(result.stdout).toContain("50005000");
			const copy = await exec(
				"psql",
				[
					"-h",
					"127.0.0.1",
					"-p",
					String(db.port),
					"-U",
					"buncargo",
					"-d",
					"postgres",
					"-v",
					"ON_ERROR_STOP=1",
					"-Atc",
					"COPY (SELECT repeat('x', 100) FROM generate_series(1,10000)) TO STDOUT",
				],
				{ timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
			);
			expect(copy.stdout.length).toBe(1010000);
			await client.withdraw(d.id, sessionId, d.owner);
			await expect(
				client.access(d.id, d.owner, sessionId, "db"),
			).rejects.toThrow();
			expect(
				(await client.list(devices[1].id, devices[1].owner)).runs,
			).toHaveLength(1);
		} finally {
			for (const f of forwards) await f.close();
			await Promise.allSettled(
				devices.map((d) => client.withdraw(d.id, sessionId, d.publisher)),
			);
			for (const p of publishers) p.close();
			await upstream.stop(true);
			if (postgres)
				await exec("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]);
			await rm(dir, { recursive: true, force: true });
		}
	},
	180000,
);
