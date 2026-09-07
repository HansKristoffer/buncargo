import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortableSleep } from "../deadline";
import { createThrottledFailureLog } from "../failure-log";
import { createTailscaleClient } from "./client";
import { directorySnapshot, type TailnetSnapshot } from "./directory";
import type { TailnetHealth } from "./health";
import { createTailnetRuntime } from "./runtime";
import { DIRECTORY_LOCAL_PORT } from "./state";

/** Keep liveness, reconciliation readiness and the last publishable snapshot distinct. */
export function createTailnetRefresh(
	runtime: Pick<ReturnType<typeof createTailnetRuntime>, "reconcile">,
	hash: string,
	deps = { now: Date.now, log: (message: string) => console.error(message) },
) {
	let snapshot: TailnetSnapshot | undefined;

	const health: TailnetHealth = {
		service: "buncargo-tailnet",
		version: 1,
		bundleHash: hash,
		ready: false,
		issues: [],
	};

	const failures = createThrottledFailureLog(deps);

	return {
		health,
		snapshot: () => snapshot,
		async refresh(signal: AbortSignal) {
			try {
				const result = await runtime.reconcile(signal);

				// Health is reachable through Serve too; keep detailed diagnostics in the local log.
				health.issues = result.issues.length
					? ["Reconciliation needs attention; run buncargo tailnet doctor"]
					: [];
				health.ready = result.issues.length === 0;
				snapshot = directorySnapshot(
					result.self,
					result.state,
					result.runs,
					result.actual,
					deps.now(),
				);

				if (health.ready) {
					health.lastSuccess = new Date(deps.now()).toISOString();
					failures.reset();
				} else failures.report(result.issues.join("; "));
			} catch (error) {
				health.ready = false;
				health.issues = [
					"Tailscale reconciliation unavailable; run buncargo tailnet doctor",
				];
				snapshot = undefined;

				if (!signal.aborted) failures.report(String(error));
			}
		},
	};
}

export async function runTailnetDaemon() {
	// Identify the copied script actually running, rather than a possibly newer installed package.
	const contents = await readFile(process.argv[1] ?? "", "utf8");
	const hash = createHash("sha256").update(contents).digest("hex");

	const refresh = createTailnetRefresh(
		createTailnetRuntime({ command: createTailscaleClient() }),
		hash,
	);

	const controller = new AbortController();
	const stop = () => controller.abort();

	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: DIRECTORY_LOCAL_PORT,
		fetch(request) {
			const path = new URL(request.url).pathname;

			if (request.method !== "GET" || request.headers.has("origin"))
				return new Response("Not allowed", { status: 403 });

			if (path === "/health")
				return Response.json(refresh.health, {
					headers: { "cache-control": "no-store" },
				});

			if (path !== "/v1/info" && path !== "/v1/runs")
				return new Response("Not found", { status: 404 });

			// A live HTTP listener must never make an old directory look like a current successful read.
			const snapshot = refresh.snapshot();

			if (!snapshot || Date.now() - Date.parse(snapshot.generatedAt) > 30000)
				return Response.json(
					{ error: "Tailnet directory unavailable" },
					{ status: 503 },
				);

			const { runs: _, ...info } = snapshot;

			return Response.json(path === "/v1/info" ? info : snapshot, {
				headers: { "cache-control": "no-store" },
			});
		},
	});

	let failed = 0;

	try {
		while (!controller.signal.aborted) {
			// Await cancellation of the operation before starting another lock-owning pass.
			await refresh.refresh(
				AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
			);
			failed = refresh.health.ready ? 0 : Math.min(failed + 1, 4);
			await abortableSleep(
				Math.min(5000 * 2 ** failed, 30000),
				controller.signal,
			);
		}
	} catch (error) {
		if (!controller.signal.aborted) throw error;
	} finally {
		server.stop(true);
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
