import { readLiveRuns } from "../run-registry";
import { createTailscaleClient, serveState, tailnetStatus } from "./client";
import { directorySnapshot, type TailnetSnapshot } from "./directory";
import { createTailnetRuntime } from "./runtime";
import { DIRECTORY_LOCAL_PORT, readTailnetState } from "./state";

/**
 * Long-running coordinator started by launchd/systemd.
 *
 * Reconciles Serve mappings, then serves the machine directory on loopback
 * for the tailnet-facing HTTPS proxy to forward to.
 */
export async function runTailnetDaemon() {
	const command = createTailscaleClient();
	const runtime = createTailnetRuntime({ command });

	let snapshot: TailnetSnapshot | undefined;
	let error: string | undefined;
	let updating = false;

	async function refresh() {
		if (updating) return;

		updating = true;

		try {
			const { issues } = await runtime.reconcile();

			for (const issue of issues) {
				console.error(issue);
			}

			const { self } = await tailnetStatus(command);
			snapshot = directorySnapshot(
				self,
				readTailnetState(),
				await readLiveRuns(),
				await serveState(command),
			);
			error = undefined;
		} catch (cause) {
			error = String(cause);
			snapshot = undefined;
			console.error(error);
		} finally {
			updating = false;
		}
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: DIRECTORY_LOCAL_PORT,
		fetch(request) {
			const path = new URL(request.url).pathname;

			// A browser page cannot read the directory using a drive-by cross-origin fetch.
			if (request.method !== "GET" || request.headers.has("origin")) {
				return new Response("Not allowed", { status: 403 });
			}

			if (path === "/health") {
				return Response.json({ service: "buncargo-tailnet", version: 1 });
			}

			if (path !== "/v1/info" && path !== "/v1/runs") {
				return new Response("Not found", { status: 404 });
			}

			if (!snapshot || error) {
				return Response.json(
					{ error: "Tailnet directory unavailable" },
					{ status: 503 },
				);
			}

			const { runs: _, ...info } = snapshot;

			return Response.json(path === "/v1/info" ? info : snapshot, {
				headers: { "cache-control": "no-store" },
			});
		},
	});

	await refresh();

	const timer = setInterval(() => void refresh(), 5000);

	await new Promise<void>((resolve) => {
		const stop = () => {
			clearInterval(timer);
			server.stop(true);
			resolve();
		};

		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
