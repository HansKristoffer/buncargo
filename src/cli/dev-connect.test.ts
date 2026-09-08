import { expect, test } from "bun:test";
import { startLocalDirectory } from "../connect-directory/local";
import { DirectoryClient } from "../core/connect/client";
import { makeSecret } from "../core/connect/protocol";
import { sleep } from "../core/sleep";
import { createDevConnect } from "./dev-connect";

test("publishes one connector to multiple recipients, tracks readiness and withdraws its session", async () => {
	const directory = await startLocalDirectory();
	const client = new DirectoryClient(directory.url);
	const devices = [0, 1].map(() => ({
		id: crypto.randomUUID(),
		owner: makeSecret(),
		token: makeSecret(),
	}));
	for (const d of devices) await client.create(d.id, d.owner, d.token);
	const connect = createDevConnect(
		{
			root: process.cwd(),
			projectPrefix: "integration",
			isWorktree: true,
			ports: { web: 3131 },
			services: {},
			resolvePrimaryApp: () => "web",
		},
		devices.map((d) => `bc1.${d.id}.${d.token}`),
		new AbortController().signal,
		directory.url,
		async ({ targets }) => ({
			endpoint: `tc${"a".repeat(60)}`,
			targets,
			exited: new Promise<void>(() => {}),
			disconnectTarget() {},
			async close() {},
		}),
	);
	connect.plan({ web: { port: 3131, devCommand: "bun web.ts" } }, []);
	connect.start("coordinator-session", []);
	connect.status(["web"], "ready");
	const wait = async (predicate: () => Promise<boolean>) => {
		for (let i = 0; i < 100; i++) {
			if (await predicate()) return;
			await sleep(10);
		}
		throw new Error("Publication timed out");
	};
	try {
		await wait(
			async () =>
				(await client.list(devices[1].id, devices[1].owner)).runs.length === 1,
		);
		await wait(
			async () =>
				(await client.list(devices[0].id, devices[0].owner)).runs[0]
					?.transport === "ready",
		);
		for (const d of devices)
			expect((await client.list(d.id, d.owner)).runs[0].targets[0].status).toBe(
				"ready",
			);
		connect.status(["web"], "failed");
		connect.status(["web"], "ready");
		await wait(
			async () =>
				(await client.list(devices[0].id, devices[0].owner)).runs[0].targets[0]
					.status === "failed",
		);
	} finally {
		await connect.stop();
	}
	expect(
		(await client.list(devices[0].id, devices[0].owner)).runs,
	).toHaveLength(0);

	await directory.stop();
});
