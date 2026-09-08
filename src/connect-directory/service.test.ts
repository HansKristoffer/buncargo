import { expect, test } from "bun:test";
import { DirectoryClient, DirectoryError } from "../core/connect/client";
import { makeSecret, type Snapshot } from "../core/connect/protocol";

import { startLocalDirectory } from "./local";

test("recipient isolation, publisher ownership, rotation, revisions and revocation", async () => {
	const server = await startLocalDirectory();
	const client = new DirectoryClient(server.url);
	const owner = makeSecret(),
		token = makeSecret(),
		publisher = makeSecret(),
		otherOwner = makeSecret(),
		otherToken = makeSecret();
	const snapshot: Snapshot = {
		version: 1,
		sessionId: "session1",
		project: "project",
		branch: "feature/foo",
		endpoint: `tc${"a".repeat(60)}`,
		transport: "ready",
		revision: 1,
		targets: [
			{
				id: "app-web",
				kind: "app",
				name: "web",
				protocol: "http",
				status: "ready",
				port: 8080,
			},
		],
	};
	try {
		await client.create("device1", owner, token);
		await client.create("device2", otherOwner, otherToken);
		await expect(client.list("device1", token)).rejects.toBeInstanceOf(
			DirectoryError,
		);
		await expect(
			client.publish("device2", token, publisher, snapshot),
		).rejects.toBeInstanceOf(DirectoryError);
		await client.publish("device1", token, publisher, snapshot);
		await expect(client.list("device1", otherOwner)).rejects.toThrow();
		await expect(client.list("device1", publisher)).rejects.toThrow();
		await expect(
			client.publish("device1", token, makeSecret(), snapshot),
		).rejects.toBeInstanceOf(DirectoryError);
		expect((await client.list("device1", owner)).runs[0].branch).toBe(
			"feature/foo",
		);
		expect((await client.list("device1", owner)).runs[0].transport).toBe(
			"ready",
		);

		await expect(
			client.publish("device1", publisher, publisher, {
				...snapshot,
				revision: 0,
			}),
		).rejects.toBeInstanceOf(DirectoryError);
		const rotated = makeSecret();
		await client.call("/v1/devices/device1/rotate", owner, "POST", {
			token: rotated,
		});
		await client.publish("device1", publisher, publisher, {
			...snapshot,
			revision: 2,
		});
		await expect(
			client.publish("device1", token, makeSecret(), {
				...snapshot,
				sessionId: "session2",
			}),
		).rejects.toBeInstanceOf(DirectoryError);
		await client.withdraw("device1", "session1", owner);
		expect((await client.list("device1", owner)).runs).toHaveLength(0);
		await expect(
			client.publish("device1", publisher, publisher, snapshot),
		).rejects.toBeInstanceOf(DirectoryError);
		await expect(
			client.publish("device1", rotated, publisher, {
				...snapshot,
				revision: 3,
			}),
		).rejects.toBeInstanceOf(DirectoryError);
	} finally {
		await server.stop();
	}
});

test("server time expires leases and terminal registrations cannot be revived", async () => {
	const { directoryRequest } = await import("./service");
	let state: import("./service").DeviceState | undefined;
	let now = Date.now();
	const owner = makeSecret(),
		token = makeSecret(),
		publisher = makeSecret();
	const call = (
		method: string,
		path: string,
		secret?: string,
		body?: unknown,
	) =>
		directoryRequest(
			new Request(`https://test.example/v1/devices/device${path}`, {
				method,
				headers: secret ? { authorization: `Bearer ${secret}` } : {},
				body: body ? JSON.stringify(body) : undefined,
			}),
			{
				recipientId: "device",
				origin: "https://test.example",
				now: () => now,
				storage: {
					load: async () => state,
					save: async (v) => {
						state = v;
					},
				},
			},
		);
	await call("POST", "", undefined, {
		owner,
		token,
	});
	const snapshot: Snapshot = {
		version: 1,
		sessionId: "session",
		project: "p",
		revision: 1,
		endpoint: `tc${"a".repeat(60)}`,
		transport: "ready",
		targets: [
			{
				id: "db",
				kind: "service",
				name: "db",
				protocol: "tcp",
				status: "ready",
				port: 8080,
			},
		],
	};
	expect(
		(
			await call("PUT", "/sessions/session", token, {
				snapshot,
				sessionSecret: publisher,
			})
		).status,
	).toBe(200);
	now += 21_000;
	const stale = (await (await call("GET", "/sessions", owner)).json()) as {
		runs: { transport: string }[];
	};
	expect(stale.runs[0].transport).toBe("connecting");
	now += 70_000;
	expect(
		(
			(await (await call("GET", "/sessions", owner)).json()) as {
				runs: unknown[];
			}
		).runs,
	).toHaveLength(0);
	expect(
		(
			await call("PUT", "/sessions/session", publisher, {
				snapshot,
				sessionSecret: publisher,
			})
		).status,
	).toBe(410);
	expect(
		(
			await call("PUT", "/sessions/session", token, {
				snapshot,
				sessionSecret: publisher,
			})
		).status,
	).toBe(200);
	await call("POST", "/rotate", owner, {
		token: makeSecret(),
		revokeAll: true,
	});
	expect(
		(await call("POST", "/sessions/session/access", owner, { target: "db" }))
			.status,
	).toBe(404);
	expect(
		(
			await call("PUT", "/sessions/session", publisher, {
				snapshot,
				sessionSecret: publisher,
			})
		).status,
	).toBe(410);
});
