import { readdir, readFile, rm } from "node:fs/promises";
import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { readProcessIdentity } from "../process-identity";
import { readLiveRuns } from "../run-registry";
import { connectOrigin } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { newCredential, readReceiver, request } from "./client";
import { intentsPath, writeCoordinatorState } from "./coordinator-state";
import {
	type Directory,
	HEARTBEAT_MS,
	parseDirectory,
	record,
} from "./protocol";
import { createPublisher, type SharingIntent } from "./publisher";
import { createVisitors } from "./visitors";
export async function runConnectDaemon() {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await withFileLock(
			stateFilePath("connect-coordinator"),
			async () => {
				const identity = readProcessIdentity(process.pid);
				if (!identity) throw new Error("Cannot identify coordinator");
				const publishers = new Map<
						string,
						ReturnType<typeof createPublisher>
					>(),
					visitors = createVisitors(),
					token = newCredential("local");
				let notice: string | undefined;
				let snapshot: Directory = {
					version: 1,
					configured: false,
					generatedAt: Date.now(),
					origin: connectOrigin(),
					runs: [],
				};
				const server = Bun.serve({
					hostname: "127.0.0.1",
					port: 0,
					maxRequestBodySize: 16384,
					async fetch(req) {
						if (
							req.headers.get("authorization") !== `Bearer ${token}` ||
							req.headers.has("origin")
						)
							return new Response(null, { status: 403 });
						const path = new URL(req.url).pathname;
						try {
							if (req.method === "GET" && path === "/status")
								return Response.json({
									...snapshot,
									generatedAt: Date.now(),
									notice: notice ?? snapshot.notice,
									connections: visitors.connections(),
									sharing: publishers.size > 0,
								});
							if (req.method !== "POST")
								return new Response(null, { status: 405 });
							const body = record(await req.json());
							if (typeof body.id !== "string")
								throw new Error("Missing target ID");
							if (path === "/disconnect") {
								await visitors.disconnect(body.id);
								return Response.json({ ok: true });
							}
							if (path === "/tcp") {
								const receiver = await readReceiver();
								if (!receiver)
									throw new Error("Run buncargo connect token first");
								return Response.json(await visitors.ensure(receiver, body.id));
							}
							return new Response(null, { status: 404 });
						} catch (error) {
							return Response.json(
								{
									error:
										error instanceof Error
											? error.message
											: "Connection failed",
								},
								{ status: 502 },
							);
						}
					},
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
				const heartbeat = setInterval(
					() => void report().catch(() => controller.abort()),
					1000,
				);
				let idleSince = Date.now();
				let next = 0;
				try {
					while (!controller.signal.aborted) {
						if (publishers.size || visitors.connections().length)
							idleSince = Date.now();
						else if (Date.now() - idleSince > 60000) break;
						if (Date.now() >= next) {
							next = Date.now() + HEARTBEAT_MS;
							notice = undefined;
							try {
								const runs = await readLiveRuns(),
									wanted = new Set<string>();
								const files = await readdir(intentsPath()).catch(() => []);
								await Promise.all(
									files
										.filter((f) => f.endsWith(".json"))
										.map(async (file) => {
											const path = `${intentsPath()}/${file}`;
											try {
												const intent = JSON.parse(
													await readFile(path, "utf8"),
												) as SharingIntent;
												const run = runs.find(
													(r) => r.sessionId === intent.sessionId,
												);
												if (!run) {
													await rm(path, { force: true });
													return;
												}
												if (intent.origin !== connectOrigin()) return;
												wanted.add(intent.sessionId);
												let publisher = publishers.get(intent.sessionId);
												if (!publisher) {
													publisher = createPublisher(intent);
													publishers.set(intent.sessionId, publisher);
												}
												const result = await publisher.refresh(run);
												if (result.rejectedRecipients)
													notice = `${result.rejectedRecipients} recipient token(s) rejected; update the sandbox secrets.`;
											} catch (error) {
												notice =
													error instanceof Error
														? error.message
														: "Publication failed";
											}
										}),
								);
								for (const [id, p] of publishers)
									if (!wanted.has(id)) {
										await p.close();
										publishers.delete(id);
									}
								const receiver = await readReceiver();
								snapshot = receiver
									? parseDirectory(
											await request(
												receiver.origin,
												"/v1/receiver/runs",
												receiver.owner,
											),
											receiver.origin,
										)
									: {
											version: 1,
											configured: false,
											origin: connectOrigin(),
											generatedAt: Date.now(),
											runs: [],
											notice:
												"Copy a connection token to receive shared environments.",
										};
								await visitors.refresh(connectOrigin());
							} catch (error) {
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
					await Promise.allSettled(
						[...publishers.values()].map((p) => p.close()),
					);
					await visitors.close();
					server.stop(true);
				}
			},
			{ timeoutMs: 1000 },
		);
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
