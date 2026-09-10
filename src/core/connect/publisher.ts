import { hostname } from "node:os";
import { isTcpPortOpen } from "../network";
import { matchesProcessIdentity } from "../process-identity";
import type { RunEntry } from "../run-registry";
import { request } from "./client";
import { type Frpc, runningProxies, startFrpc } from "./frpc";
import { createGate } from "./gate";
import {
	LEASE_MS,
	type PublicationLease,
	type RunInput,
	ready,
} from "./protocol";
import { runTargets } from "./targets";

export interface SharingIntent {
	sessionId: string;
	tokens: string[];
	name: string;
	origin: string;
	credential: string;
}

/** One publisher per run isolates identity and teardown across worktrees sharing a home. */
export function createPublisher(intent: SharingIntent) {
	let lease: PublicationLease | undefined;
	let deadline = 0;
	let frpc: Frpc | undefined;
	let signature = "";
	let current: RunEntry | undefined;
	const gates = new Map<
		string,
		{
			gate: Awaited<ReturnType<typeof createGate>>;
			port: number;
			identity?: string;
		}
	>();

	// Disable every gate before awaiting any close: no target may accept work during teardown.
	const closeGates = async () => {
		for (const entry of gates.values()) {
			entry.gate.disable();
		}
		for (const entry of gates.values()) {
			await entry.gate.close();
		}
		gates.clear();
	};

	const active = () =>
		performance.now() < deadline &&
		!!current &&
		matchesProcessIdentity(current.pid, current.processIdentity);

	const refresh = async (run: RunEntry) => {
		current = run;
		const targets = runTargets(run);
		await Promise.all(
			targets.map(async (target) => {
				if (ready(target.status) && !(await isTcpPortOpen(target.port))) {
					target.status = "starting";
				}
			}),
		);
		const input: RunInput = {
			sessionId: intent.sessionId,
			name: intent.name,
			hostname: hostname(),
			project: run.projectPrefix,
			branch: run.branch,
			worktree: run.worktree,
			primaryApp: run.primaryApp,
			targets: targets.map(
				({ pid: _pid, processIdentity: _identity, ...target }) => target,
			),
		};
		if (
			input.primaryApp &&
			!targets.some(
				(target) => target.name === input.primaryApp && target.kind === "app",
			)
		) {
			delete input.primaryApp;
		}

		// Register once, then renew the same publication and report only routes confirmed by frpc.
		const confirmed = frpc
			? runningProxies(await frpc.status().catch(() => ({})))
			: [];
		const started = performance.now();
		lease = lease
			? await request<PublicationLease>(
					intent.origin,
					`/v1/publications/${lease.id}`,
					intent.credential,
					{ run: input, confirmed },
					"PUT",
				)
			: await request<PublicationLease>(
					intent.origin,
					"/v1/publications",
					undefined,
					{
						tokens: intent.tokens,
						run: input,
						credential: intent.credential,
					},
				);
		if (
			!Array.isArray(lease.assignments) ||
			lease.assignments.length > 1024 ||
			lease.credential !== intent.credential ||
			!/^[a-f0-9]{32}$/.test(lease.id)
		) {
			throw new Error("Invalid publication lease");
		}
		deadline = started + Math.min(LEASE_MS, Math.max(0, lease.remainingMs));

		// Retire revoked routes and gates whose port or process identity changed before adding routes.
		for (const [id, entry] of gates) {
			const assignment = lease.assignments.find(
				(assignment) => assignment.id === id,
			);
			const target = targets.find(
				(target) => target.id === assignment?.targetId,
			);
			if (
				!target ||
				target.port !== entry.port ||
				target.processIdentity !== entry.identity
			) {
				await entry.gate.close();
				gates.delete(id);
			}
		}

		const proxies: Record<string, unknown>[] = [];
		for (const assignment of lease.assignments) {
			const target = targets.find(
				(target) => target.id === assignment.targetId,
			);
			if (!target || !ready(target.status)) {
				continue;
			}
			if (
				!/^[a-f0-9]{32}$/.test(assignment.id) ||
				assignment.protocol !== target.protocol
			) {
				throw new Error("Invalid proxy allocation");
			}
			let entry = gates.get(assignment.id);
			if (!entry) {
				const gate = await createGate(
					target.port,
					() =>
						active() &&
						(!target.pid ||
							matchesProcessIdentity(target.pid, target.processIdentity)),
				);
				entry = {
					gate,
					port: target.port,
					identity: target.processIdentity,
				};
				gates.set(assignment.id, entry);
			}
			proxies.push({
				name: assignment.id,
				type: assignment.protocol === "http" ? "http" : "stcp",
				localIP: "127.0.0.1",
				localPort: entry.gate.port,
				// Lossless tunnel compression leaves application bytes and debugging unchanged.
				transport: { useCompression: assignment.protocol === "http" },
				...(assignment.protocol === "http"
					? {
							subdomain: assignment.subdomain,
							hostHeaderRewrite: `localhost:${target.port}`,
						}
					: { secretKey: assignment.secretKey }),
			});
		}

		// Unchanged proxy definitions must leave open database and streaming connections intact.
		const next = JSON.stringify(proxies);
		if (next !== signature || !frpc?.alive()) {
			if (frpc?.alive()) {
				await frpc.reload(proxies);
			} else {
				await frpc?.close();
				frpc = undefined;
				signature = "";
				if (proxies.length) {
					frpc = await startFrpc({
						relay: lease.relay,
						user: lease.user,
						credential: intent.credential,
						proxies,
					});
				}
			}
			signature = next;
		}
		return {
			targets: proxies.length,
			rejectedRecipients: lease.rejectedRecipients,
		};
	};

	let failures = 0;
	let nextAttempt = 0;
	let lastError: unknown;

	return {
		async refresh(run: RunEntry) {
			// Back off a failing publication independently; another worktree can keep renewing.
			if (performance.now() < nextAttempt) {
				throw lastError;
			}
			try {
				const result = await refresh(run);
				failures = 0;
				return result;
			} catch (error) {
				lastError = error;
				const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
				nextAttempt = performance.now() + delay * (0.8 + Math.random() * 0.2);
				throw error;
			}
		},
		async close() {
			deadline = 0;
			await closeGates();
			await frpc?.close();
			if (lease) {
				await request(
					intent.origin,
					`/v1/publications/${lease.id}`,
					intent.credential,
					undefined,
					"DELETE",
				).catch(() => {});
			}
		},
	};
}
