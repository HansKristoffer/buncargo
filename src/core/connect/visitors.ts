import { abortableSleep } from "../deadline";
import { isTcpPortOpen } from "../tcp-probe";
import { request } from "./client";
import { type Frpc, freePort, startFrpc } from "./frpc";
import {
	HEX_ID,
	LEASE_MS,
	type Receiver,
	type TCPConnection,
	type VisitorLease,
} from "./protocol";

function visitorScheme(preset: string | undefined) {
	if (preset === "postgres") return "postgresql";
	if (preset === "redis") return "redis";
	return "tcp";
}

interface Visitor {
	client: Frpc;
	lease: VisitorLease;
	deadline: number;
	connection: TCPConnection;
}

export function createVisitors() {
	const entries = new Map<string, Visitor>();
	const pending = new Map<string, Promise<TCPConnection>>();

	let timer: ReturnType<typeof setInterval> | undefined;
	const stopTimerIfEmpty = () => {
		if (entries.size === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const ensureTimer = () => {
		if (timer) return;
		// Independently enforce leases even when network renewal or directory polling stalls.
		// Runs only while at least one visitor is active so idle daemons wake zero timers.
		timer = setInterval(() => {
			for (const [id, entry] of entries) {
				if (performance.now() >= entry.deadline) {
					void disconnect(id);
				}
			}
			stopTimerIfEmpty();
		}, 250);
		timer.unref();
	};

	const disconnect = async (id: string) => {
		const entry = entries.get(id);
		entries.delete(id);
		stopTimerIfEmpty();
		await entry?.client.close();
	};

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
			!HEX_ID.test(lease.proxyName) ||
			!/^bc_tcp_[a-f0-9]{64}$/.test(lease.secretKey)
		) {
			throw new Error("Invalid visitor grant");
		}

		// A visitor that never starts listening is retried on a new port.
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

			const scheme = visitorScheme(lease.target.preset);
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
			ensureTimer();
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
			// A failed start left nothing to wait for; the disconnect below still runs.
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
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			await Promise.allSettled(pending.values());
			await Promise.all([...entries.keys()].map(disconnect));
		},
	};
}
