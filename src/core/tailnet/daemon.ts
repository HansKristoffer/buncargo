import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortableSleep } from "../deadline";
import { createThrottledFailureLog } from "../failure-log";
import type { RunEntry } from "../run-registry";
import { createTailscaleClient, record } from "./client";
import {
	directoryRunId,
	directorySnapshot,
	type TailnetSnapshot,
} from "./directory";
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
	// The registry entries behind the snapshot: a stop needs their `cli`, which never travels.
	let runs: RunEntry[] = [];

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
		runs: () => runs,
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
				runs = result.runs;

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
				runs = [];

				if (!signal.aborted) failures.report(String(error));
			}
		},
	};
}

/**
 * `POST /v1/stop` `{ run, app? }`: a peer's BuncargoBar stopping a shared app,
 * or the whole run when `app` is omitted.
 *
 * Only what the directory advertises can be named, and the work is the run's
 * own `buncargo stop` — the same thing the local Bar shells out to — so the
 * daemon never signals a process itself. `--force` because the Bar has already
 * confirmed and nobody is at this terminal to answer a prompt.
 */
export async function remoteStop(
	body: unknown,
	snapshot: TailnetSnapshot | undefined,
	runs: RunEntry[],
	exec: typeof execBuncargo = execBuncargo,
): Promise<{ status: number; error?: string }> {
	let request: Record<string, unknown>;
	try {
		request = record(body);
	} catch {
		return { status: 400, error: "Invalid stop request" };
	}
	const { run: id, app } = request;
	if (typeof id !== "string" || (app !== undefined && typeof app !== "string"))
		return { status: 400, error: "Invalid stop request" };

	const shared = snapshot?.runs.find((run) => run.id === id);
	const run = runs.find((entry) => directoryRunId(entry) === id);
	if (!shared || !run || (app && !shared.apps.some((a) => a.name === app)))
		return { status: 404, error: "No longer shared from this machine" };

	const result = await exec(run, ["stop", app ?? "--all", "--force"]);
	const message = result.stderr || "buncargo stop failed";
	switch (result.code) {
		case 0:
			return { status: 200 };
		case 2:
			return { status: 404, error: message };
		case 3:
			return { status: 403, error: message };
		default:
			return { status: 500, error: message };
	}
}

async function execBuncargo(
	run: RunEntry,
	argv: string[],
): Promise<{ code: number; stderr: string }> {
	const proc = Bun.spawn(
		[
			run.cli.program,
			...(run.cli.script ? [run.cli.script] : []),
			...argv,
			"--root",
			run.root,
			...(run.sessionId ? ["--run", run.sessionId] : []),
		],
		{
			cwd: run.root,
			env: {
				...process.env,
				// launchd/systemd PATH has no Docker; stopping a whole run needs it.
				PATH: [process.env.PATH, "/usr/local/bin", "/opt/homebrew/bin"]
					.filter(Boolean)
					.join(":"),
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			timeout: 20000,
		},
	);
	const stderr = await new Response(proc.stderr).text();
	return { code: (await proc.exited) || 0, stderr: stderr.trim() };
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

	// A stop changes the directory; wake the loop so the peer's next read sees it.
	let wake = new AbortController();
	const refreshed: (() => void)[] = [];
	const nextRefresh = () =>
		new Promise<void>((resolve) => {
			refreshed.push(resolve);
			wake.abort();
		});

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: DIRECTORY_LOCAL_PORT,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const stopping = request.method === "POST" && path === "/v1/stop";

			if (
				(request.method !== "GET" && !stopping) ||
				request.headers.has("origin")
			)
				return new Response("Not allowed", { status: 403 });

			if (path === "/health")
				return Response.json(refresh.health, {
					headers: { "cache-control": "no-store" },
				});

			if (!stopping && path !== "/v1/info" && path !== "/v1/runs")
				return new Response("Not found", { status: 404 });

			// A live HTTP listener must never make an old directory look like a current successful read.
			const snapshot = refresh.snapshot();

			if (!snapshot || Date.now() - Date.parse(snapshot.generatedAt) > 30000)
				return Response.json(
					{ error: "Tailnet directory unavailable" },
					{ status: 503 },
				);

			if (stopping) {
				const body = await request.text();
				const result = await remoteStop(
					body.length <= 4096 ? JSON.parse(body) : undefined,
					snapshot,
					refresh.runs(),
				).catch(() => ({ status: 400, error: "Invalid stop request" }));
				if (result.status === 200) await nextRefresh();
				return Response.json(
					{ ok: result.status === 200, error: result.error },
					{ status: result.status, headers: { "cache-control": "no-store" } },
				);
			}

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
			// Only a pass that began after the stop reflects it; later waiters take the next one.
			const waiting = refreshed.splice(0);
			await refresh.refresh(
				AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
			);
			failed = refresh.health.ready ? 0 : Math.min(failed + 1, 4);
			for (const resolve of waiting) resolve();
			try {
				await abortableSleep(
					Math.min(5000 * 2 ** failed, 30000),
					AbortSignal.any([controller.signal, wake.signal]),
				);
			} catch (error) {
				if (!wake.signal.aborted) throw error;
				wake = new AbortController();
			}
		}
	} catch (error) {
		if (!controller.signal.aborted) throw error;
	} finally {
		server.stop(true);
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
