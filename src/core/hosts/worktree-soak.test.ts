import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NamedHost } from "../../types";
import {
	certificateFingerprint,
	syncCertificateForRoutes,
} from "./certificates";
import { createHostsReloader } from "./daemon";
import { waitForDaemonRoutes } from "./daemon-client";
import { writeDaemonConfig } from "./daemon-config";
import { resolvedMkcertPath } from "./mkcert";
import { certificateHostnames } from "./plan";
import { type LocalProxy, startLocalProxy } from "./proxy";
import { pruneHostRoutes, routesFromPlan, upsertHostRoutes } from "./registry";

/**
 * The failure the user reported: a hostname that "sometimes" does not attach in
 * a worktree, leaving the run on `localhost:port` with no error.
 *
 * It was never one bug. Registering a route, widening the certificate and
 * waiting for the daemon to pick it up are three steps against shared state,
 * and each had a window: the daemon dropped its listener to rebind after a
 * remint, the CLI treated one unanswered probe as fatal, and concurrent runs
 * could mint certificates that omitted each other. Any single run passes almost
 * always, which is exactly why this has to be a soak.
 *
 * Opt-in: it drives a real proxy, real file locking and real minting through
 * `mkcert`, and can download `mkcert` on a machine that has none.
 *
 *     BUNCARGO_TEST_HOSTS_SOAK=1 bun test src/core/hosts/worktree-soak.test.ts
 */

const enabled = process.env.BUNCARGO_TEST_HOSTS_SOAK === "1";
const describeSoak = enabled ? describe : describe.skip;

/** Worktrees to bring up per round, in parallel. */
const WORKTREES_PER_ROUND = 4;
const ROUNDS = 5;

function planFor(worktree: string): NamedHost[] {
	return [
		{
			kind: "app",
			name: "api",
			hostname: `${worktree}.api.soak.localhost`,
			baseHostname: `${worktree}.api.soak.localhost`,
			targetPort: 4100,
		},
		{
			kind: "app",
			name: "web",
			hostname: `${worktree}.soak.localhost`,
			baseHostname: `${worktree}.soak.localhost`,
			targetPort: 4200,
		},
	];
}

describeSoak("named hosts under worktree churn", () => {
	let home: string;
	let proxy: LocalProxy | undefined;
	let stopReloading: (() => void) | undefined;
	const originalHome = process.env.HOME;
	const originalMkcert = process.env.BUNCARGO_MKCERT_PATH;

	beforeAll(async () => {
		// Resolve mkcert before HOME moves, then pin it: the temp home has no
		// tool cache, and without a real binary nothing is ever reminted — which
		// is the event that makes the daemon rebind, and the rebind is half of
		// what this test exists to cover.
		const mkcert = resolvedMkcertPath();
		if (mkcert) process.env.BUNCARGO_MKCERT_PATH = mkcert;

		home = mkdtempSync(join(tmpdir(), "buncargo-soak-"));
		process.env.HOME = home;

		// A stand-in for the installed service: the same reloader the daemon
		// runs, over the same registry and certificate, on an unprivileged port.
		const reloader = createHostsReloader({
			pruneRoutes: () => pruneHostRoutes(),
			certificateFingerprint,
			describeCertificateGap: () => undefined,
			readCertificatePair: async () => ({ cert: "", key: "" }),
			startProxy: async (input) => {
				const started = await startLocalProxy({
					lookup: input.lookup,
					routes: input.routes,
					httpsPort: proxy?.httpsPort ?? 0,
					hostname: "127.0.0.1",
				});
				proxy = started;
				writeDaemonConfig({
					httpsPort: started.httpsPort,
					httpPort: 0,
					tls: false,
				});
				return started;
			},
			log: () => {},
			now: Date.now,
			onIdleExit: () => {},
			service: true,
		});

		await reloader.reload();
		const timer = setInterval(() => {
			void reloader.reload().catch(() => {});
		}, 50);
		stopReloading = () => {
			clearInterval(timer);
			reloader.stop();
		};
	});

	afterAll(() => {
		stopReloading?.();
		proxy?.stop();
		process.env.HOME = originalHome;
		if (originalMkcert === undefined) {
			delete process.env.BUNCARGO_MKCERT_PATH;
		} else {
			process.env.BUNCARGO_MKCERT_PATH = originalMkcert;
		}
		rmSync(home, { recursive: true, force: true });
	});

	/** One worktree's activation, the same order `activateNamedHosts` uses. */
	async function activate(worktree: string): Promise<boolean> {
		const plan = planFor(worktree);
		// A real directory: a checkout that is gone has its remembered
		// certificate names pruned, which is a different rule from this one.
		const root = join(home, "checkouts", worktree);
		mkdirSync(root, { recursive: true });

		await syncCertificateForRoutes({
			include: certificateHostnames(plan, "localhost"),
			root,
		}).catch(() => {
			// A machine with no mkcert still exercises the registry and the
			// route pickup, which is where the reported failure lived.
		});

		await upsertHostRoutes(
			routesFromPlan(plan, { root, pid: process.pid, kinds: ["app"] }),
		);

		const serving = await waitForDaemonRoutes(
			plan.map((entry) => entry.hostname),
		);
		return serving.ok;
	}

	it("attaches every hostname, every time, across parallel worktrees", async () => {
		const failures: string[] = [];

		for (let round = 0; round < ROUNDS; round++) {
			const worktrees = Array.from(
				{ length: WORKTREES_PER_ROUND },
				(_, index) => `t3code-${round}${index}`,
			);
			const results = await Promise.all(
				worktrees.map(async (worktree) => ({
					worktree,
					ok: await activate(worktree),
				})),
			);
			for (const result of results) {
				if (!result.ok) failures.push(result.worktree);
			}
		}

		expect(failures).toEqual([]);
	}, 120_000);
});
