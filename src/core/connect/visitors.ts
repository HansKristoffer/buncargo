import { abortableSleep } from "../deadline";
import { isTcpPortOpen } from "../network";
import { request } from "./client";
import { type Frpc, freePort, startFrpc } from "./frpc";
import {
	LEASE_MS,
	type Receiver,
	type TCPConnection,
	type VisitorLease,
} from "./protocol";

interface Visitor {
	client: Frpc;
	lease: VisitorLease;
	deadline: number;
	connection: TCPConnection;
}

export function createVisitors() {
	const entries = new Map<string, Visitor>();
	const pending = new Map<string, Promise<TCPConnection>>();
	const disconnect = async (id: string) => {
		const entry = entries.get(id);
		entries.delete(id);
		await entry?.client.close();
	};
	// Independently enforce leases even when network renewal or directory polling stalls.
	const timer = setInterval(() => {
		for (const [id, entry] of entries) {
			if (performance.now() >= entry.deadline) {
				void disconnect(id);
			}
		}
	}, 250);
	timer.unref();
	const ensure = async (
		receiver: Receiver,
		id: string,
	): Promise<TCPConnection> => {
		const existing = entries.get(id);
		if (existing?.client.alive() && performance.now() < existing.deadline) {
			return existing.connection;
		}
		await disconnect(id);
		const started = performance.now();
		const lease = await request<VisitorLease>(
			receiver.origin,
			`/v1/targets/${encodeURIComponent(id)}/visitor`,
			receiver.owner,
			{},
		);
		if (
			lease.target.id !== id ||
			!/^[a-f0-9]{32}$/.test(lease.proxyName) ||
			!/^bc_tcp_[a-f0-9]{64}$/.test(lease.secretKey)
		) {
			throw new Error("Invalid visitor grant");
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			const port = await freePort();
			const client = await startFrpc({
				relay: lease.relay,
				user: lease.user,
				credential: lease.credential,
				visitors: [
					{
						name: lease.proxyName,
						type: "stcp",
						serverName: lease.proxyName,
						serverUser: lease.user,
						secretKey: lease.secretKey,
						bindAddr: "127.0.0.1",
						bindPort: port,
					},
				],
			});
			let bound = false;
			for (let i = 0; i < 30; i++) {
				if (await isTcpPortOpen(port)) {
					bound = true;
					break;
				}
				await abortableSleep(100);
			}
			if (!bound) {
				await client.close();
				continue;
			}
			const scheme =
				lease.target.preset === "postgres"
					? "postgresql"
					: lease.target.preset === "redis"
						? "redis"
						: "tcp";
			let url = `${scheme}://127.0.0.1:${port}`;
			let tablePlusUrl: string | undefined;
			if (lease.target.tablePlusUrl) {
				const address = new URL(lease.target.tablePlusUrl);
				if (
					!["postgresql:", "redis:", "clickhouse:"].includes(address.protocol)
				) {
					await client.close();
					throw new Error("Invalid database URL");
				}
				address.hostname = "127.0.0.1";
				address.port = String(port);
				url = address.toString();
				if (address.protocol !== "redis:") {
					tablePlusUrl = url;
				}
			}
			const connection = { targetId: id, port, url, tablePlusUrl };
			entries.set(id, {
				client,
				lease,
				deadline: started + Math.min(LEASE_MS, lease.remainingMs),
				connection,
			});
			return connection;
		}
		throw new Error(
			"Could not bind a local visitor; check relay access and retry",
		);
	};
	return {
		ensure(receiver: Receiver, id: string) {
			let task = pending.get(id);
			if (!task) {
				task = ensure(receiver, id).finally(() => pending.delete(id));
				pending.set(id, task);
			}
			return task;
		},
		async disconnect(id: string) {
			// A click during startup must not leave a listener appearing after disconnect returned.
			await pending.get(id)?.catch(() => {});
			await disconnect(id);
		},
		connections: () => [...entries.values()].map((entry) => entry.connection),
		async refresh(origin: string) {
			await Promise.all(
				[...entries].map(async ([id, entry]) => {
					try {
						const start = performance.now();
						const renewal = await request<{ remainingMs: number }>(
							origin,
							"/v1/visitor/renew",
							entry.lease.credential,
							{},
						);
						entry.deadline = start + Math.min(LEASE_MS, renewal.remainingMs);
					} catch {
						if (entries.get(id) === entry) {
							await disconnect(id);
						}
					}
				}),
			);
		},
		async close() {
			clearInterval(timer);
			await Promise.allSettled(pending.values());
			await Promise.all([...entries.keys()].map(disconnect));
		},
	};
}
