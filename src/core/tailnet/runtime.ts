import { isPortInUse } from "../process";
import {
	matchesProcessIdentity,
	readProcessIdentity,
} from "../process-identity";
import { type RunEntry, readLiveRuns } from "../run-registry";
import {
	createTailscaleClient,
	mappingState,
	serveState,
	type TailscaleCommand,
	tailnetStatus,
} from "./client";
import {
	allocationPort,
	DIRECTORY_PORT,
	mutateTailnet,
	type TailnetAllocation,
	type TailnetLease,
	type TailnetState,
	workspaceId,
} from "./state";

export interface TailnetRuntimeOptions {
	command?: TailscaleCommand;
	busy?: (port: number) => boolean;
	alive?: (pid: number, identity?: string) => boolean;
	runs?: () => Promise<RunEntry[]>;
}

export const leaseTarget = (lease: TailnetLease) =>
	`http://127.0.0.1:${lease.upstream}`;

export const allocationUrl = (a: TailnetAllocation) =>
	a.lease ? `https://${a.lease.hostname}:${a.port}` : undefined;

export function createTailnetRuntime(options: TailnetRuntimeOptions = {}) {
	const command = options.command ?? createTailscaleClient();
	const alive = options.alive ?? matchesProcessIdentity;
	const busy = options.busy ?? isPortInUse;
	const runs = options.runs ?? readLiveRuns;

	async function remove(a: TailnetAllocation) {
		if (!a.lease) return;
		const current = await serveState(command);
		const disposition = mappingState(
			current,
			a.lease.hostname,
			a.port,
			leaseTarget(a.lease),
		);
		if (disposition === "conflict")
			throw new Error(
				`Tailnet port ${a.port} was changed outside buncargo; refusing to remove it. Restore its mapping or reassign it with buncargo tailnet release --port=${a.port}.`,
			);
		if (disposition === "owned")
			await command(["serve", "--bg", `--https=${a.port}`, "off"]);
		delete a.lease;
	}

	async function acquire(input: {
		root: string;
		apps: { name: string; port: number; reused: boolean }[];
		pid?: number;
		identity?: string;
		signal?: AbortSignal;
	}) {
		input.signal?.throwIfAborted();
		const active: TailscaleCommand = (args) => command(args, input.signal);
		const pid = input.pid ?? process.pid;
		const identity = input.identity ?? readProcessIdentity(pid);
		if (!identity)
			throw new Error("Cannot establish tailnet process ownership");
		const { self } = await tailnetStatus(active);
		return mutateTailnet(async (state, save) => {
			const urls: Record<string, string> = {};
			const changed: TailnetAllocation[] = [];
			try {
				for (const app of input.apps) {
					input.signal?.throwIfAborted();
					const key = `${workspaceId(input.root)}:${app.name}`;
					let allocation = state.allocations.find((a) => a.key === key);
					if (
						allocation?.lease &&
						!alive(allocation.lease.pid, allocation.lease.identity)
					) {
						await remove(allocation);
						await save();
					}
					if (allocation?.lease) {
						const l = allocation.lease;
						if (
							!app.reused ||
							l.upstream !== app.port ||
							l.hostname !== self.hostname
						)
							throw new Error(
								`${app.name} already has a tailnet owner. Restart with --takeover to change its URL mode.`,
							);
						if (
							mappingState(
								await serveState(active),
								l.hostname,
								allocation.port,
								leaseTarget(l),
							) !== "owned"
						)
							throw new Error(
								`Tailnet mapping for ${app.name} is unavailable; run buncargo tailnet doctor`,
							);
						urls[app.name] = `https://${l.hostname}:${allocation.port}`;
						continue;
					}
					if (app.reused)
						throw new Error(
							`${app.name} was started without tailnet URLs. Restart it with --takeover.`,
						);
					let actual = await serveState(active);
					if (!allocation) {
						const occupied = new Set(state.allocations.map((a) => a.port));
						occupied.add(DIRECTORY_PORT);
						for (;;) {
							const port = allocationPort(key, occupied);
							if (
								mappingState(actual, self.hostname, port, "") === "free" &&
								!busy(port)
							) {
								allocation = { key, port };
								break;
							}
							occupied.add(port);
						}
						state.allocations.push(allocation);
					}
					if (
						mappingState(actual, self.hostname, allocation.port, "") !==
							"free" ||
						busy(allocation.port)
					)
						throw new Error(
							`Reserved tailnet port ${allocation.port} is occupied. Free it or use buncargo tailnet release --port=${allocation.port} while the app is stopped.`,
						);
					allocation.lease = {
						pid,
						identity,
						root: input.root,
						app: app.name,
						upstream: app.port,
						hostname: self.hostname,
						createdAt: Date.now(),
					};
					changed.push(allocation);
					await save(); // Journal ownership before the external mutation, including interrupted commands.
					await active([
						"serve",
						"--bg",
						"--yes",
						`--https=${allocation.port}`,
						leaseTarget(allocation.lease),
					]);
					input.signal?.throwIfAborted();
					actual = await serveState(active);
					if (
						mappingState(
							actual,
							self.hostname,
							allocation.port,
							leaseTarget(allocation.lease),
						) !== "owned"
					)
						throw new Error(
							`Tailscale did not activate port ${allocation.port}. Enable HTTPS in the tailnet and check CLI permissions.`,
						);
					urls[app.name] = `https://${self.hostname}:${allocation.port}`;
				}

				return urls;
			} catch (error) {
				const cleanupErrors: string[] = [];
				for (const allocation of changed) {
					try {
						await remove(allocation);
					} catch (cleanup) {
						cleanupErrors.push(String(cleanup));
					}
				}
				await save();
				if (cleanupErrors.length)
					throw new Error(
						`${String(error)}; pending cleanup: ${cleanupErrors.join("; ")}`,
					);
				throw error;
			}
		}, input.signal);
	}

	async function release(root: string, pid = process.pid, app?: string) {
		return mutateTailnet(async (state, save) => {
			for (const a of state.allocations) {
				if (
					a.lease?.root === root &&
					a.lease.pid === pid &&
					(!app || a.lease.app === app)
				) {
					await remove(a);
					await save();
				}
			}
		});
	}

	async function reconcile() {
		const live = await runs();
		return mutateTailnet(async (state, save) => {
			const { self } = await tailnetStatus(command);
			const issues: string[] = [];
			if (state.enabled && state.directory) {
				const d = state.directory;
				const port = d.port ?? DIRECTORY_PORT;
				try {
					if (d.hostname !== self.hostname)
						throw new Error(
							"Machine DNS name changed; reinstall the tailnet directory",
						);
					const disposition = mappingState(
						await serveState(command),
						d.hostname,
						port,
						d.target,
					);
					if (disposition === "conflict")
						throw new Error(`Discovery port ${port} has a foreign mapping`);
					if (disposition === "free")
						await command([
							"serve",
							"--bg",
							"--yes",
							`--https=${port}`,
							d.target,
						]);
				} catch (error) {
					issues.push(String(error));
				}
			}
			for (const a of state.allocations) {
				try {
					const l = a.lease;
					if (!l) continue;
					const run = live.find((r) => r.root === l.root && r.pid === l.pid);
					const app = run?.apps.find((v) => v.name === l.app);
					const expired =
						!alive(l.pid, l.identity) ||
						(app &&
							(app.status === "failed" ||
								app.status === "stopped" ||
								(app.pid !== undefined &&
									!alive(app.pid, app.processIdentity)))) ||
						(!app && Date.now() - l.createdAt > 120000);
					if (expired || l.hostname !== self.hostname) {
						await remove(a);
						await save();
						continue;
					}
					// Reconnect can clear Serve state. Restore only mappings with a live app,
					// never a startup reservation pointing at a potentially recycled port.
					if (app?.pid && alive(app.pid, app.processIdentity)) {
						const disposition = mappingState(
							await serveState(command),
							l.hostname,
							a.port,
							leaseTarget(l),
						);
						if (disposition === "conflict")
							throw new Error(`Tailnet port ${a.port} has a foreign mapping`);
						if (disposition === "free")
							await command([
								"serve",
								"--bg",
								"--yes",
								`--https=${a.port}`,
								leaseTarget(l),
							]);
					}
				} catch (error) {
					// An unrelated conflict must not prevent cleanup of other leases.
					issues.push(String(error));
				}
			}

			return { state, issues };
		});
	}

	async function clear(state: TailnetState, save: () => Promise<void>) {
		for (const a of state.allocations) {
			await remove(a);
			await save();
		}
	}

	return { acquire, release, reconcile, clear, command };
}
