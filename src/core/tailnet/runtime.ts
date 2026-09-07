import { createPortOwnerSnapshot } from "../process";
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

export function leaseMatchesRun(lease: TailnetLease, run: RunEntry): boolean {
	return (
		lease.root === run.root &&
		lease.pid === run.pid &&
		(lease.sessionId === undefined || lease.sessionId === run.sessionId) &&
		(run.processIdentity === undefined ||
			run.processIdentity === lease.identity)
	);
}

export const allocationUrl = (a: TailnetAllocation) =>
	a.lease ? `https://${a.lease.hostname}:${a.port}` : undefined;

/**
 * Runtime for per-app Serve mappings and the machine directory.
 *
 * All external mutations go through `mutateTailnet` so ownership is journaled
 * before Tailscale CLI calls and rolled back on failure.
 */
export function createTailnetRuntime(options: TailnetRuntimeOptions = {}) {
	const command = options.command ?? createTailscaleClient();
	const alive = options.alive ?? matchesProcessIdentity;

	const runs = options.runs ?? readLiveRuns;

	// ── Serve helpers ────────────────────────────────────────────────────────

	async function remove(allocation: TailnetAllocation, active = command) {
		if (!allocation.lease) return;

		const current = await serveState(active);

		const disposition = mappingState(
			current,
			allocation.lease.hostname,
			allocation.port,
			leaseTarget(allocation.lease),
		);

		if (disposition === "conflict") {
			throw new Error(
				`Tailnet port ${allocation.port} was changed outside buncargo; refusing to remove it. Restore its mapping or reassign it with buncargo tailnet release --port=${allocation.port}.`,
			);
		}

		if (disposition === "owned") {
			await active(["serve", "--bg", `--https=${allocation.port}`, "off"]);
		}

		delete allocation.lease;
	}

	// ── Acquire ──────────────────────────────────────────────────────────────

	async function acquire(input: {
		root: string;
		apps: { name: string; port: number; reused: boolean }[];
		pid?: number;
		identity?: string;
		sessionId?: string;
		signal?: AbortSignal;
	}) {
		input.signal?.throwIfAborted();

		const active: TailscaleCommand = (args) => command(args, input.signal);
		const pid = input.pid ?? process.pid;
		const identity = input.identity ?? readProcessIdentity(pid);

		if (!identity) {
			throw new Error("Cannot establish tailnet process ownership");
		}

		const { self } = await tailnetStatus(active);

		return mutateTailnet(async (state, save) => {
			if (state.removing)
				throw new Error(
					"Tailnet uninstall is pending; finish cleanup before starting a new remote run",
				);

			const busy =
				options.busy ?? createPortOwnerSnapshot({ includeCwd: false }).isBusy;

			const urls: Record<string, string> = {};
			const changed: TailnetAllocation[] = [];

			try {
				for (const app of input.apps) {
					input.signal?.throwIfAborted();

					const key = `${workspaceId(input.root)}:${app.name}`;
					let allocation = state.allocations.find((a) => a.key === key);

					// Drop stale leases whose owner process is gone.
					if (
						allocation?.lease &&
						(allocation.lease.pendingRemoval ||
							!alive(allocation.lease.pid, allocation.lease.identity))
					) {
						await remove(allocation, active);
						await save();
					}

					// Reuse an existing lease when the app was started by this run.
					if (allocation?.lease) {
						const l = allocation.lease;

						if (
							!app.reused ||
							l.upstream !== app.port ||
							l.hostname !== self.hostname
						) {
							throw new Error(
								`${app.name} already has a tailnet owner. Restart with --takeover to change its URL mode.`,
							);
						}

						if (
							mappingState(
								await serveState(active),
								l.hostname,
								allocation.port,
								leaseTarget(l),
							) !== "owned"
						) {
							throw new Error(
								`Tailnet mapping for ${app.name} is unavailable; run buncargo tailnet doctor`,
							);
						}

						urls[app.name] = `https://${l.hostname}:${allocation.port}`;

						continue;
					}

					if (app.reused) {
						throw new Error(
							`${app.name} was started without tailnet URLs. Restart it with --takeover.`,
						);
					}

					let actual = await serveState(active);
					let checkedPort = false;

					// Reserve a port on first use; hash determines probe order.
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
								checkedPort = true;

								break;
							}

							occupied.add(port);
						}

						state.allocations.push(allocation);
					}

					if (
						mappingState(actual, self.hostname, allocation.port, "") !==
							"free" ||
						(!checkedPort && busy(allocation.port))
					) {
						throw new Error(
							`Reserved tailnet port ${allocation.port} is occupied. Free it or use buncargo tailnet release --port=${allocation.port} while the app is stopped.`,
						);
					}

					allocation.lease = {
						pid,
						identity,
						sessionId: input.sessionId,
						root: input.root,
						app: app.name,
						upstream: app.port,
						hostname: self.hostname,
						createdAt: Date.now(),
					};
					changed.push(allocation);

					// Journal ownership before the external mutation, including interrupted commands.
					await save();

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
					) {
						throw new Error(
							`Tailscale did not activate port ${allocation.port}. Enable HTTPS in the tailnet and check CLI permissions.`,
						);
					}

					urls[app.name] = `https://${self.hostname}:${allocation.port}`;
				}

				return urls;
			} catch (error) {
				const cleanupErrors: string[] = [];
				const cleanupSignal = AbortSignal.timeout(10000);

				const cleanupCommand: TailscaleCommand = (args) =>
					command(args, cleanupSignal);

				for (const allocation of changed)
					if (allocation.lease) allocation.lease.pendingRemoval = true;

				await save();

				for (const allocation of changed) {
					try {
						await remove(allocation, cleanupCommand);
					} catch (cleanup) {
						cleanupErrors.push(String(cleanup));
					}
				}

				await save();

				if (cleanupErrors.length) {
					throw new Error(
						`${String(error)}; pending cleanup: ${cleanupErrors.join("; ")}`,
					);
				}

				throw error;
			}
		}, input.signal);
	}

	// ── Release ──────────────────────────────────────────────────────────────

	async function removeAll(
		allocations: TailnetAllocation[],
		save: () => Promise<void>,
		active = command,
	) {
		for (const a of allocations) if (a.lease) a.lease.pendingRemoval = true;

		await save();

		const issues: unknown[] = [];

		for (const a of allocations) {
			try {
				await remove(a, active);
				await save();
			} catch (error) {
				issues.push(error);
			}
		}

		if (issues.length)
			throw new AggregateError(
				issues,
				`Pending tailnet cleanup: ${issues.map(String).join("; ")}`,
			);
	}

	async function release(root: string, pid = process.pid, app?: string) {
		const signal = AbortSignal.timeout(15000);
		const active: TailscaleCommand = (args) => command(args, signal);

		return mutateTailnet(
			async (state, save) =>
				removeAll(
					state.allocations.filter(
						(a) =>
							a.lease?.root === root &&
							a.lease.pid === pid &&
							(!app || a.lease.app === app),
					),
					save,
					active,
				),
			signal,
		);
	}

	/** Remove the directory only after comparing its recorded target with Serve. */
	async function removeDirectory(
		state: TailnetState,
		save: () => Promise<void>,
		active = command,
	) {
		const d = state.directory;

		if (!d) return;

		const port = d.port ?? DIRECTORY_PORT;

		const disposition = mappingState(
			await serveState(active),
			d.hostname,
			port,
			d.target,
		);

		if (disposition === "conflict")
			throw new Error(
				`Discovery port ${port} was changed outside buncargo; refusing to remove it`,
			);

		if (disposition === "owned")
			await active(["serve", "--bg", `--https=${port}`, "off"]);

		delete state.directory;
		await save();
	}

	/** One verified read snapshot per phase; re-read before each external mutation. */
	async function reconcile(signal?: AbortSignal) {
		const active: TailscaleCommand = (args) => command(args, signal);

		return mutateTailnet(async (state, save) => {
			signal?.throwIfAborted();

			const live = await runs();
			const { self } = await tailnetStatus(active);
			let actual = await serveState(active);
			const issues: string[] = [];
			let mutated = false;

			const restore = async (
				hostname: string,
				port: number,
				target: string,
			) => {
				let disposition = mappingState(actual, hostname, port, target);

				if (disposition === "free") {
					actual = await serveState(active);
					disposition = mappingState(actual, hostname, port, target);

					if (disposition === "free") {
						mutated = true;
						await active(["serve", "--bg", "--yes", `--https=${port}`, target]);
						actual = await serveState(active);

						if (mappingState(actual, hostname, port, target) !== "owned")
							throw new Error(`Tailnet port ${port} did not activate`);
					}
				}

				if (disposition === "conflict")
					throw new Error(`Tailnet port ${port} has a foreign mapping`);
			};

			if (state.directory) {
				try {
					if (!state.enabled || state.removing) {
						mutated = true;
						await removeDirectory(state, save, active);
					} else if (state.directory.hostname !== self.hostname)
						throw new Error(
							"Machine DNS name changed; uninstall the old tailnet directory before reinstalling",
						);
					else
						await restore(
							state.directory.hostname,
							state.directory.port ?? DIRECTORY_PORT,
							state.directory.target,
						);
				} catch (error) {
					issues.push(String(error));
				}
			}

			for (const a of state.allocations) {
				signal?.throwIfAborted();

				try {
					const l = a.lease;

					if (!l) continue;

					const app = live
						.find((r) => leaseMatchesRun(l, r))
						?.apps.find((v) => v.name === l.app);

					const expired =
						!alive(l.pid, l.identity) ||
						(app &&
							(app.status === "failed" ||
								app.status === "stopped" ||
								(app.pid !== undefined &&
									!alive(app.pid, app.processIdentity)))) ||
						(!app && Date.now() - l.createdAt > 120000);

					if (
						!state.enabled ||
						state.removing ||
						l.pendingRemoval ||
						expired ||
						l.hostname !== self.hostname
					) {
						l.pendingRemoval = true;
						await save();
						mutated = true;
						await remove(a, active);
						await save();
					} else if (app?.pid && alive(app.pid, app.processIdentity)) {
						await restore(l.hostname, a.port, leaseTarget(l));
					}
				} catch (error) {
					issues.push(String(error));
				}
			}

			signal?.throwIfAborted();

			if (mutated) actual = await serveState(active);

			return { state, issues, self, runs: live, actual };
		}, signal);
	}

	async function clear(state: TailnetState, save: () => Promise<void>) {
		const issues: unknown[] = [];
		const signal = AbortSignal.timeout(15000);
		const active: TailscaleCommand = (args) => command(args, signal);

		try {
			await removeAll(state.allocations, save, active);
		} catch (error) {
			issues.push(error);
		}

		try {
			await removeDirectory(state, save, active);
		} catch (error) {
			issues.push(error);
		}

		if (issues.length)
			throw new AggregateError(
				issues,
				`Pending tailnet cleanup: ${issues.map(String).join("; ")}`,
			);
	}

	return { acquire, release, reconcile, clear, command };
}
