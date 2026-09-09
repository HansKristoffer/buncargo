import { connect } from "node:net";
import { hostname } from "node:os";
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
export async function portReady(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host: "127.0.0.1", port });
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
		s.setTimeout(1000, () => done(false));
	});
}
/** One publisher per run isolates identity and teardown across worktrees sharing a home. */
export function createPublisher(intent: SharingIntent) {
	let lease: PublicationLease | undefined,
		deadline = 0,
		frpc: Frpc | undefined,
		signature = "",
		current: RunEntry | undefined;
	const gates = new Map<
		string,
		{
			gate: Awaited<ReturnType<typeof createGate>>;
			port: number;
			targetId: string;
			identity?: string;
		}
	>();
	const closeGates = async () => {
		for (const v of gates.values()) v.gate.disable();
		for (const v of gates.values()) await v.gate.close();
		gates.clear();
	};
	const active = () =>
		performance.now() < deadline &&
		!!current &&
		matchesProcessIdentity(current.pid, current.processIdentity);
	return {
		async refresh(run: RunEntry) {
			current = run;
			const targets = runTargets(run);
			await Promise.all(
				targets.map(async (t) => {
					if (ready(t.status) && !(await portReady(t.port)))
						t.status = "starting";
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
					({ pid: _pid, processIdentity: _identity, ...t }) => t,
				),
			};
			if (
				input.primaryApp &&
				!targets.some((t) => t.name === input.primaryApp && t.kind === "app")
			)
				delete input.primaryApp;
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
			)
				throw new Error("Invalid publication lease");
			deadline = started + Math.min(LEASE_MS, Math.max(0, lease.remainingMs));
			for (const [id, entry] of gates) {
				const a = lease.assignments.find((a) => a.id === id),
					t = targets.find((t) => t.id === a?.targetId);
				if (
					!t ||
					t.port !== entry.port ||
					t.processIdentity !== entry.identity
				) {
					await entry.gate.close();
					gates.delete(id);
				}
			}
			const proxies: Record<string, unknown>[] = [];
			for (const a of lease.assignments) {
				const target = targets.find((t) => t.id === a.targetId);
				if (!target || !ready(target.status)) continue;
				if (!/^[a-f0-9]{32}$/.test(a.id) || a.protocol !== target.protocol)
					throw new Error("Invalid proxy allocation");
				let entry = gates.get(a.id);
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
						targetId: target.id,
						identity: target.processIdentity,
					};
					gates.set(a.id, entry);
				}
				proxies.push({
					name: a.id,
					type: a.protocol === "http" ? "http" : "stcp",
					localIP: "127.0.0.1",
					localPort: Number(entry.gate.target.split(":")[1]),
					transport: { useCompression: false },
					...(a.protocol === "http"
						? {
								subdomain: a.subdomain,
								hostHeaderRewrite: `localhost:${target.port}`,
							}
						: { secretKey: a.secretKey }),
				});
			}
			const next = JSON.stringify(proxies);
			if (next !== signature || !frpc?.alive()) {
				await frpc?.close();
				frpc = undefined;
				signature = "";
				if (proxies.length)
					frpc = await startFrpc({
						relay: lease.relay,
						user: lease.user,
						credential: intent.credential,
						proxies,
					});
				signature = next;
			}
			return {
				targets: proxies.length,
				rejectedRecipients: lease.rejectedRecipients,
			};
		},
		async close() {
			deadline = 0;
			await closeGates();
			await frpc?.close();
			if (lease)
				await request(
					intent.origin,
					`/v1/publications/${lease.id}`,
					intent.credential,
					undefined,
					"DELETE",
				).catch(() => {});
		},
	};
}
