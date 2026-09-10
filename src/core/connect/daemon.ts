import { readdir, readFile, rm } from "node:fs/promises";
import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { readProcessIdentity } from "../process-identity";
import { readLiveRuns } from "../run-registry";
import { connectOrigin } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { emptyDirectory, readDirectory, requireReceiver } from "./client";
import { intentsPath, writeCoordinatorState } from "./coordinator-state";
import { newCredential } from "./credentials";
import { HEARTBEAT_MS, record } from "./protocol";
import { createPublisher, type SharingIntent } from "./publisher";
import { createVisitors } from "./visitors";

const IDLE_TIMEOUT_MS = 60_000;

/** Each run owns its recipients; the shared coordinator never inherits the first run's tokens. */
function createPublications(origin: string) {
	const publishers = new Map<string, ReturnType<typeof createPublisher>>();

	return {
		get active() {
			return publishers.size > 0;
		},

		async refresh(): Promise<string | undefined> {
			const runs = await readLiveRuns();
			const wanted = new Set<string>();
			const files = await readdir(intentsPath()).catch(() => []);
			let notice: string | undefined;

			// Renew worktrees together so one failed request cannot consume every run's lease.
			await Promise.all(
				files
					.filter((file) => file.endsWith(".json"))
					.map(async (file) => {
						const path = `${intentsPath()}/${file}`;

						try {
							const intent = JSON.parse(
								await readFile(path, "utf8"),
							) as SharingIntent;
							const run = runs.find(
								(run) => run.sessionId === intent.sessionId,
							);
							if (!run) {
								await rm(path, { force: true });
								return;
							}
							if (intent.origin !== origin) {
								return;
							}

							wanted.add(intent.sessionId);
							let publisher = publishers.get(intent.sessionId);
							if (!publisher) {
								publisher = createPublisher(intent);
								publishers.set(intent.sessionId, publisher);
							}

							const result = await publisher.refresh(run);
							if (result.rejectedRecipients) {
								notice = `${result.rejectedRecipients} recipient token(s) rejected; update the sandbox secrets.`;
							}
						} catch (error) {
							notice =
								error instanceof Error ? error.message : "Publication failed";
						}
					}),
			);

			for (const [id, publisher] of publishers) {
				if (!wanted.has(id)) {
					await publisher.close();
					publishers.delete(id);
				}
			}

			return notice;
		},

		async close() {
			await Promise.allSettled(
				[...publishers.values()].map((publisher) => publisher.close()),
			);
		},
	};
}

/** Run while holding the machine-wide lifetime lock; release listeners before releasing the lock. */
async function runCoordinator(controller: AbortController) {
	const identity = readProcessIdentity(process.pid);
	if (!identity) {
		throw new Error("Cannot identify coordinator");
	}

	const origin = connectOrigin();
	const publications = createPublications(origin);
	const visitors = createVisitors();
	const token = newCredential("local");
	let snapshot = emptyDirectory();
	let notice: string | undefined;

	async function handleRequest(request: Request): Promise<Response> {
		if (
			request.headers.get("authorization") !== `Bearer ${token}` ||
			request.headers.has("origin")
		) {
			return new Response(null, { status: 403 });
		}

		const path = new URL(request.url).pathname;
		try {
			if (request.method === "GET" && path === "/status") {
				return Response.json({
					...snapshot,
					generatedAt: Date.now(),
					notice: notice ?? snapshot.notice,
					connections: visitors.connections(),
					sharing: publications.active,
				});
			}
			if (request.method !== "POST") {
				return new Response(null, { status: 405 });
			}

			const body = record(await request.json());
			if (typeof body.id !== "string") {
				throw new Error("Missing target ID");
			}

			if (path === "/disconnect") {
				await visitors.disconnect(body.id);
				return Response.json({ ok: true });
			}
			if (path === "/tcp") {
				return Response.json(
					await visitors.ensure(await requireReceiver(), body.id),
				);
			}
			return new Response(null, { status: 404 });
		} catch (error) {
			return Response.json(
				{
					error: error instanceof Error ? error.message : "Connection failed",
				},
				{ status: 502 },
			);
		}
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 16384,
		fetch: handleRequest,
	});
	const report = () =>
		writeCoordinatorState({
			pid: process.pid,
			identity,
			bundle: process.argv[1] ?? "",
			updatedAt: Date.now(),
			ready: true,
			connection: { port: server.port ?? 0, token },
			cli: { program: process.execPath, script: process.argv[1] },
		});

	await report();
	// Local readiness stays fresh even while a remote directory request is waiting.
	const heartbeat = setInterval(
		() => void report().catch(() => controller.abort()),
		1000,
	);
	let idleSince = Date.now();
	let nextRefresh = 0;

	try {
		while (!controller.signal.aborted) {
			if (publications.active || visitors.connections().length) {
				idleSince = Date.now();
			} else if (Date.now() - idleSince > IDLE_TIMEOUT_MS) {
				break;
			}

			if (Date.now() >= nextRefresh) {
				nextRefresh = Date.now() + HEARTBEAT_MS;
				notice = undefined;

				try {
					notice = await publications.refresh();
					snapshot = await readDirectory();
					await visitors.refresh(origin);
				} catch (error) {
					// Never keep actionable rows from an unreachable directory.
					snapshot = { ...snapshot, runs: [], generatedAt: Date.now() };
					notice =
						error instanceof Error
							? error.message
							: "Connection directory unavailable";
				}
			}

			await abortableSleep(500, controller.signal);
		}
	} finally {
		clearInterval(heartbeat);
		await publications.close();
		await visitors.close();
		server.stop(true);
	}
}

export async function runConnectDaemon() {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);

	try {
		await withFileLock(
			stateFilePath("connect-coordinator"),
			() => runCoordinator(controller),
			{ timeoutMs: 1000 },
		);
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
