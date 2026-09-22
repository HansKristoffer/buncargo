import { randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import type { Endpoint } from "@number0/iroh";
import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { readProcessIdentity } from "../process-identity";
import { readLiveRuns } from "../run-registry";
import { stateFilePath } from "../state-paths";
import { intentsPath, writeCoordinatorState } from "./coordinator-state";
import { ensurePublisher, readReceiver } from "./identity";
import { bindEndpoint } from "./iroh";
import {
	type Directory,
	emptyDirectory,
	HEARTBEAT_MS,
	parseToken,
	type RunInput,
	record,
} from "./protocol";
import {
	createPublisher,
	type PublishedRun,
	type Publisher,
} from "./publisher";
import { createReceiver, type Receiver } from "./receiver";
import { runTargets } from "./targets";

const IDLE_TIMEOUT_MS = 60_000;

/** What one `dev` invocation asked to share, and with whom. */
export interface SharingIntent {
	sessionId: string;
	tokens: string[];
	name: string;
}

interface Recipient {
	token: string;
	name: string;
	runs: PublishedRun[];
}

/**
 * Group this machine's runs by the recipient they were shared with.
 *
 * Recipients come from each invocation's own intent file, never from the
 * first one the coordinator happened to see: two worktrees under one home
 * must not inherit each other's tokens.
 */
async function collectRecipients(): Promise<Map<string, Recipient>> {
	const runs = await readLiveRuns();
	const files = await readdir(intentsPath()).catch(() => []);
	const recipients = new Map<string, Recipient>();

	await Promise.all(
		files
			.filter((file) => file.endsWith(".json"))
			.map(async (file) => {
				const path = `${intentsPath()}/${file}`;
				const intent = (await readFile(path, "utf8")
					.then((body) => record(JSON.parse(body)))
					.catch(() => undefined)) as SharingIntent | undefined;
				const run =
					intent && runs.find((r) => r.sessionId === intent.sessionId);
				if (!run) {
					await rm(path, { force: true });
					return;
				}
				const targets = runTargets(run);
				const input: RunInput = {
					sessionId: intent.sessionId,
					name: intent.name,
					hostname: hostname(),
					project: run.projectPrefix,
					branch: run.branch,
					worktree: run.worktree,
					primaryApp: targets.some(
						(target) => target.name === run.primaryApp && target.kind === "app",
					)
						? run.primaryApp
						: undefined,
					targets: targets.map(
						({ pid: _pid, processIdentity: _identity, ...target }) => target,
					),
				};
				for (const token of intent.tokens ?? []) {
					try {
						parseToken(token);
					} catch {
						continue;
					}
					const recipient = recipients.get(token) ?? {
						token,
						name: intent.name,
						runs: [],
					};
					recipient.runs.push({ input, targets });
					recipients.set(token, recipient);
				}
			}),
	);
	return recipients;
}

/** Publishers live as long as a recipient is still named by some intent. */
function createPublications() {
	const publishers = new Map<string, Publisher>();
	let endpoint: Endpoint | undefined;

	return {
		get active() {
			return publishers.size > 0;
		},

		async refresh(): Promise<string | undefined> {
			const recipients = await collectRecipients();
			for (const [token, publisher] of publishers) {
				if (!recipients.has(token)) {
					await publisher.close();
					publishers.delete(token);
				}
			}
			if (!recipients.size) {
				return undefined;
			}
			if (!endpoint) {
				const identity = await ensurePublisher();
				endpoint = await bindEndpoint(identity.secretKey);
			}
			let notice: string | undefined;
			// Renew recipients together so one unreachable Mac cannot stall the rest.
			await Promise.all(
				[...recipients.values()].map(async (recipient) => {
					let publisher = publishers.get(recipient.token);
					if (!publisher) {
						publisher = createPublisher({
							endpoint: endpoint as Endpoint,
							token: parseToken(recipient.token),
							name: recipient.name,
							hostname: hostname(),
						});
						publishers.set(recipient.token, publisher);
					}
					try {
						await publisher.update(recipient.runs);
					} catch (error) {
						notice =
							error instanceof Error ? error.message : "Sharing unavailable";
					}
				}),
			);
			return notice;
		},

		async close() {
			await Promise.allSettled(
				[...publishers.values()].map((publisher) => publisher.close()),
			);
			publishers.clear();
			await endpoint?.close();
			endpoint = undefined;
		},
	};
}

/** Run while holding the machine-wide lifetime lock; release listeners before releasing the lock. */
async function runCoordinator(controller: AbortController) {
	const identity = readProcessIdentity(process.pid);
	if (!identity) {
		throw new Error("Cannot identify coordinator");
	}

	const publications = createPublications();
	const stored = await readReceiver();
	let receiver: Receiver | undefined;
	if (stored) {
		receiver = createReceiver(stored);
		await receiver.start();
	}
	const token = randomBytes(32).toString("hex");
	let notice: string | undefined;

	const snapshot = (): Directory =>
		receiver?.directory() ??
		emptyDirectory("Copy a connection token to receive shared environments.");

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
				const directory = snapshot();
				return Response.json({
					...directory,
					generatedAt: Date.now(),
					notice: notice ?? directory.notice,
					sharing: publications.active,
				});
			}
			if (request.method !== "POST") {
				return new Response(null, { status: 405 });
			}

			const body = record(await request.json());
			if (typeof body.id !== "string") {
				throw new Error("Missing remote environment ID");
			}
			if (path === "/revoke") {
				if (!receiver) {
					throw new Error("Run buncargo connect token first");
				}
				await receiver.revoke(body.id);
				return Response.json({ ok: true });
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
	// Local readiness stays fresh even while a publisher dial is still pending.
	const heartbeat = setInterval(
		() => void report().catch(() => controller.abort()),
		1000,
	);
	let idleSince = Date.now();
	let nextRefresh = 0;

	try {
		while (!controller.signal.aborted) {
			// A receiver is a service: while this machine can be published to, it stays up.
			if (publications.active || receiver) {
				idleSince = Date.now();
			} else if (Date.now() - idleSince > IDLE_TIMEOUT_MS) {
				break;
			}

			if (Date.now() >= nextRefresh) {
				nextRefresh = Date.now() + HEARTBEAT_MS;
				try {
					// A token copied after startup makes this machine a receiver too.
					if (!receiver) {
						const created = await readReceiver();
						if (created) {
							receiver = createReceiver(created);
							await receiver.start();
						}
					}
					notice = await publications.refresh();
					await receiver?.refresh();
				} catch (error) {
					notice =
						error instanceof Error ? error.message : "Sharing unavailable";
				}
			}

			await abortableSleep(500, controller.signal);
		}
	} finally {
		clearInterval(heartbeat);
		await publications.close();
		await receiver?.close();
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
