import { createServer } from "node:http";
import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { readProcessIdentity } from "../process-identity";
import { readLiveRuns } from "../run-registry";
import { tailscaleAuthKey, tailscaleProcessEnv } from "../runtime-flags";
import { stateFilePath } from "../state-paths";
import { startGuardedChild } from "./child-guard";
import { tailnetStatus } from "./client";
import {
	COORDINATOR_MAX_AGE_MS,
	COORDINATOR_STARTING,
	type CoordinatorState,
	writeCoordinatorState,
} from "./coordinator-state";
import { listenEndpoint, serveTarget } from "./endpoint";
import { createMappings, type Mapping, type Mappings } from "./mappings";
import { DIRECTORY_PORT, type Directory } from "./protocol";
import { createPublisher } from "./publisher";
import { startTailnetRuntime } from "./runtime";

/** One process per user/sandbox, shared by all live worktrees. No systemd or privileged service needed. */
export async function runTailnetDaemon() {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const authKey = tailscaleAuthKey();
	process.env = tailscaleProcessEnv();
	try {
		await withFileLock(
			stateFilePath("tailnet-coordinator"),
			async () => {
				const identity = readProcessIdentity(process.pid);
				if (!identity)
					throw new Error("Cannot establish coordinator process identity");
				const state: CoordinatorState = {
					pid: process.pid,
					identity,
					bundle: process.argv[1] ?? "",
					updatedAt: Date.now(),
					ready: false,
					cli: { program: process.execPath, script: process.argv[1] },
				};
				const report = (ready: boolean, message?: string) =>
					writeCoordinatorState({
						...state,
						updatedAt: Date.now(),
						ready,
						message,
					});
				await report(false, COORDINATOR_STARTING);
				let runtime:
					| Awaited<ReturnType<typeof startTailnetRuntime>>
					| undefined;
				let mappings: Mappings | undefined;
				let publisher: ReturnType<typeof createPublisher> | undefined;
				let snapshot: Directory | undefined;
				const server = createServer((req, res) => {
					if (
						req.method !== "GET" ||
						req.headers.origin ||
						req.url !== "/v1/runs"
					) {
						res.writeHead(403);
						res.end();
						return;
					}
					if (
						!snapshot ||
						Date.now() - snapshot.generatedAt > COORDINATOR_MAX_AGE_MS
					) {
						res.writeHead(503);
						res.end();
						return;
					}
					res.writeHead(200, {
						"content-type": "application/json",
						"cache-control": "no-store",
					});
					res.end(JSON.stringify(snapshot));
				});
				try {
					runtime = await startTailnetRuntime(authKey, controller.signal);
					state.connection = { binary: runtime.binary, socket: runtime.socket };
					const version = await runtime.command(["version"], controller.signal);
					const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
					if (
						!match ||
						Number(match[1]) < 1 ||
						(Number(match[1]) === 1 &&
							(Number(match[2]) < 102 ||
								(Number(match[2]) === 102 && Number(match[3]) < 3)))
					)
						throw new Error(
							"Sharing requires Tailscale 1.102.3 or later. Update Tailscale on this machine.",
						);
					const { binary, socket } = runtime;
					mappings = createMappings(runtime.command, (args) =>
						startGuardedChild(binary, [
							...(socket ? [`--socket=${socket}`] : []),
							...args,
						]),
					);
					const endpoint = await listenEndpoint(server);
					let self = (await tailnetStatus(runtime.command, controller.signal))
						.self;
					let directoryMapping: Mapping = {
						hostname: self.hostname,
						port: DIRECTORY_PORT,
						protocol: "http",
						target: serveTarget(endpoint, "http"),
					};
					await mappings.acquire(directoryMapping);
					publisher = createPublisher(mappings);
					let idleSince = Date.now();
					while (!controller.signal.aborted) {
						try {
							const runs = await readLiveRuns();
							if (runs.length) idleSince = Date.now();
							else if (Date.now() - idleSince > 60000) break;
							self = (await tailnetStatus(runtime.command, controller.signal))
								.self;
							if (self.hostname !== directoryMapping.hostname) {
								await mappings.remove(directoryMapping);
								directoryMapping = {
									...directoryMapping,
									hostname: self.hostname,
								};
								await mappings.acquire(directoryMapping);
							} else
								await mappings.restore(
									directoryMapping,
									await mappings.state(),
								);
							snapshot = await publisher.refresh(self, runs);
							await report(true);
						} catch (error) {
							snapshot = undefined;
							await publisher.close();
							// Drop our foreground sessions without changing other Serve configuration.
							await mappings.clear().catch(() => {});
							await report(
								false,
								error instanceof Error
									? error.message
									: "Tailscale sharing unavailable",
							);
						}
						await abortableSleep(2000, controller.signal);
					}
				} catch (error) {
					if (!controller.signal.aborted)
						await report(
							false,
							error instanceof Error
								? error.message
								: "Tailscale sharing failed",
						);
				} finally {
					snapshot = undefined;
					await publisher?.close();
					server.closeAllConnections();
					await mappings?.clear().catch(() => {});
					server.close();
					await runtime?.close();
				}
			},
			{ timeoutMs: 1000 },
		);
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
