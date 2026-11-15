import { expect, test } from "bun:test";
import { newCredential } from "../../src/core/connect/credentials";
import {
	LEASE_MS,
	parseDirectory,
	type RunInput,
} from "../../src/core/connect/protocol";
import { ConnectionDirectory } from "./directory";
import { createAPI, frpHook } from "./http";
import { Store } from "./store";

const run: RunInput = {
	sessionId: "run-a",
	name: "Cursor",
	hostname: "sandbox",
	project: "lullu",
	branch: "main",
	worktree: null,
	targets: [
		{
			id: "api",
			name: "api",
			kind: "app",
			protocol: "http",
			status: "ready",
			port: 4900,
		},
		{
			id: "db",
			name: "db",
			kind: "service",
			protocol: "tcp",
			status: "ready",
			port: 7332,
		},
	],
};

function fixture() {
	let now = Date.now();
	const store = new Store(":memory:", Buffer.alloc(32, 1));
	const directory = new ConnectionDirectory(
		store,
		"https://connect.example.com",
		{
			host: "connect.example.com",
			port: 7000,
			serverName: "connect.example.com",
		},
		() => now,
	);
	return {
		directory,
		store,
		tick: () => {
			now += LEASE_MS + 1;
		},
	};
}

test("publish-only tokens, multi-recipient isolation, idempotence, and revocation", () => {
	const { directory, store } = fixture();
	try {
		const a = directory.createReceiver();
		const b = directory.createReceiver();
		const c = directory.createReceiver();

		const cred = newCredential("pub");
		const p = directory.register([a.token, b.token], run, cred);
		expect(p.assignments).toHaveLength(3);
		expect(directory.register([a.token], run, cred).id).toBe(p.id);
		expect(() => directory.list(a.token)).toThrow("Not authorized");
		expect(directory.list(c.owner).runs).toHaveLength(0);
		expect(directory.list(a.owner).runs[0].name).toBe("Cursor");

		const http = p.assignments.find((t) => t.protocol === "http");
		const tcpA = p.assignments.find((t) => t.receiverId === a.id);
		if (!http || !tcpA) {
			throw new Error("Missing assignments");
		}

		// frpc's client API returns bare proxy names, unlike server hook names.
		directory.update(p.id, cred, run, [http.id, tcpA.id]);
		expect(
			directory.list(a.owner).runs[0].targets.map((t) => t.status),
		).toEqual(["ready", "ready"]);
		expect(
			directory.list(b.owner).runs[0].targets.map((t) => t.status),
		).toEqual(["ready", "starting"]);

		const v = directory.visitor(a.owner, `${p.id}.db`);
		expect(directory.session(v.credential).role).toBe("visitor");

		directory.revoke(a.owner, p.id);
		expect(directory.list(a.owner).runs).toHaveLength(0);
		expect(directory.list(b.owner).runs).toHaveLength(1);
		expect(() => directory.renewVisitor(v.credential)).toThrow();

		const next = directory.update(p.id, cred, run);
		expect(next.assignments).toHaveLength(2);
		expect(directory.list(a.owner).runs).toHaveLength(0);
		expect(() => directory.retire(p.id, newCredential("pub"))).toThrow();
		directory.retire(p.id, cred);
		expect(directory.list(b.owner).runs).toHaveLength(0);
	} finally {
		store.close();
	}
});

test("leases and restart invalidate saved visitor credentials", () => {
	const { directory, store, tick } = fixture();
	try {
		const a = directory.createReceiver();
		const cred = newCredential("pub");
		const p = directory.register([a.token], run, cred);
		const v = directory.visitor(a.owner, `${p.id}.db`);
		tick();
		expect(directory.list(a.owner).runs).toHaveLength(0);
		expect(() => directory.session(v.credential)).toThrow();
		directory.update(p.id, cred, run);
		directory.invalidateLeases();
		expect(directory.list(a.owner).runs).toHaveLength(0);
		expect(() => directory.session(cred)).toThrow();
	} finally {
		store.close();
	}
});

test("frps hook rejects forged namespaces and visitor publication; routing is server-owned", () => {
	const { directory, store } = fixture();
	try {
		const a = directory.createReceiver();
		const cred = newCredential("pub");
		const p = directory.register([a.token], run, cred);
		const http = p.assignments.find((a) => a.protocol === "http");
		if (!http) {
			throw new Error("HTTP assignment missing");
		}

		const user = { user: p.id, metas: { credential: cred } };
		expect(
			frpHook(directory, "Login", {
				content: { ...user, user: "somebody-else" },
			}),
		).toHaveProperty("reject", true);

		const result = frpHook(directory, "NewProxy", {
			content: {
				user,
				proxy_name: `${p.id}.${http.id}`,
				proxy_type: "http",
				custom_domains: ["evil.example"],
				subdomain: "stolen",
			},
		});
		expect(result).toHaveProperty("content.subdomain", http.subdomain);
		expect(result).not.toHaveProperty("content.custom_domains");

		const v = directory.visitor(a.owner, `${p.id}.db`);
		expect(
			frpHook(directory, "NewProxy", {
				content: { user: { user: p.id, metas: { credential: v.credential } } },
			}),
		).toHaveProperty("reject", true);
	} finally {
		store.close();
	}
});

test("API rejects browser requests, oversized input, and owner credential misuse", async () => {
	const { directory, store } = fixture();
	try {
		const api = createAPI(directory);
		const a = directory.createReceiver();
		expect(
			(
				await api(
					new Request("https://connect.example.com/v1/receiver/runs", {
						headers: {
							origin: "https://evil.test",
							authorization: `Bearer ${a.owner}`,
						},
					}),
				)
			).status,
		).toBe(403);
		expect(
			(
				await api(
					new Request("https://connect.example.com/v1/receiver/runs", {
						headers: { authorization: `Bearer ${a.token}` },
					}),
				)
			).status,
		).toBe(403);
		expect(
			(
				await api(
					new Request("https://connect.example.com/v1/receivers", {
						method: "POST",
						body: "x".repeat(131073),
					}),
				)
			).status,
		).toBe(413);
	} finally {
		store.close();
	}
});

test("stopping the primary app does not invalidate the remaining directory", () => {
	const { directory, store } = fixture();
	try {
		const receiver = directory.createReceiver();
		const credential = newCredential("pub");
		const initial = { ...run, primaryApp: "api" };
		const p = directory.register([receiver.token], initial, credential);
		directory.update(p.id, credential, {
			...initial,
			targets: initial.targets.map((t) =>
				t.id === "api" ? { ...t, status: "stopped" } : t,
			),
		});
		const result = parseDirectory(
			directory.list(receiver.owner),
			directory.origin,
		);
		expect(result.runs[0]?.primaryApp).toBeUndefined();
		expect(result.runs[0]?.targets.map((t) => t.name)).toEqual(["db"]);
	} finally {
		store.close();
	}
});
