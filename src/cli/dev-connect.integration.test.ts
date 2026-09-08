import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, connect as tcpConnect } from "node:net";
import { startLocalDirectory } from "../connect-directory/local";
import { DirectoryClient } from "../core/connect/client";
import { makeSecret, type Registration } from "../core/connect/protocol";
import {
	type Forward,
	localForward,
} from "../core/connect/transport/local-forward";
import { tailcatTestsEnabled } from "../core/runtime-flags";
import { createDevConnect } from "./dev-connect";

test.skipIf(!tailcatTestsEnabled())(
	"two recipients: revoked TCP stream closes, other recipient survives, directory outage closes sharing",
	async () => {
		const directory = await startLocalDirectory();
		const client = new DirectoryClient(directory.url);
		const devices = [0, 1].map(() => ({
			id: crypto.randomUUID(),
			owner: makeSecret(),
			token: makeSecret(),
		}));
		for (const d of devices) await client.create(d.id, d.owner, d.token);
		const echo = createServer((s) => {
			s.on("error", () => {});
			s.pipe(s);
		});
		echo.listen(0, "127.0.0.1");
		await once(echo, "listening");
		const port = (echo.address() as { port: number }).port;
		const sharing = createDevConnect(
			{
				root: process.cwd(),
				projectPrefix: "lifecycle",
				isWorktree: true,
				ports: { db: port },
				services: {},
				resolvePrimaryApp: () => "db",
			},
			devices.map((d) => `bc1.${d.id}.${d.token}`),
			new AbortController().signal,
			directory.url,
			undefined,
			200,
		);
		sharing.plan(
			{
				db: { port, devCommand: "unused", exposeProtocol: "tcp" },
			},
			[],
		);
		sharing.start(crypto.randomUUID(), ["db"]);
		const forwards: Forward[] = [];
		const sockets: ReturnType<typeof tcpConnect>[] = [];
		try {
			for (const d of devices) {
				let run: Registration | undefined;
				for (let i = 0; i < 300; i++) {
					run = (await client.list(d.id, d.owner)).runs[0];
					if (run) break;
					await Bun.sleep(100);
				}
				if (!run) throw new Error("No published Tailcat session");
				const f = await localForward(run.endpoint, run.targets[0]);
				forwards.push(f);
				const socket = tcpConnect({ host: "127.0.0.1", port: f.port });
				socket.on("error", () => {});
				sockets.push(socket);
				const data = once(socket, "data");
				socket.write("connected");
				expect(String((await data)[0])).toBe("connected");
			}
			const d = devices[0];
			const run = (await client.list(d.id, d.owner)).runs[0];
			const closed = once(sockets[0], "close");
			await client.withdraw(d.id, run.sessionId, d.owner);
			await closed;
			const other = once(sockets[1], "data");
			sockets[1].write("still connected");
			expect(String((await other)[0])).toBe("still connected");
			const outage = once(sockets[1], "close");
			await directory.stop();
			await outage;
		} finally {
			for (const s of sockets) s.destroy();
			for (const f of forwards) await f.close();
			await sharing.stop();
			await directory.stop();
			echo.close();
		}
	},
	60000,
);
