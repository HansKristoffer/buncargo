/**
 * This machine's live runs, served to the other machines on its tailnet.
 *
 * BuncargoBar on another machine lists the online peers from its own
 * `tailscale status` and asks each one here, so runs on a server appear in the
 * menu without setup. The watchdog serves it, one per machine, for as long as
 * there are runs to show.
 *
 * Bound to the Tailscale address only: the tailnet's ACLs decide who may read
 * it, and nothing on the LAN or the internet reaches it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { REGISTRY_VERSION, readLiveRuns } from "./run-registry";
import { tailscaleAddress } from "./tailscale";

/** BuncargoBar asks every peer on this port. */
export const TAILNET_DIRECTORY_PORT = 48480;

function createDirectoryServer(readRuns: typeof readLiveRuns): Server {
	return createServer(async (request, response) => {
		if (request.method !== "GET" || request.url !== "/v1/runs") {
			response.writeHead(404).end();
			return;
		}
		try {
			// The same document as runs.json, live entries only: the reader
			// cannot check a pid on another machine.
			const body = JSON.stringify({
				version: REGISTRY_VERSION,
				runs: await readRuns(),
			});
			response.writeHead(200, { "content-type": "application/json" }).end(body);
		} catch {
			response.writeHead(503).end();
		}
	});
}

/**
 * Serve while the machine has a Tailscale address, following it as it comes,
 * goes or changes. Returns the function that stops serving.
 */
export function serveTailnetDirectory(options: {
	log: (message: string) => void;
	intervalMs: number;
	port?: number;
	address?: () => string | undefined;
	readRuns?: typeof readLiveRuns;
}): () => void {
	const port = options.port ?? TAILNET_DIRECTORY_PORT;
	const address = options.address ?? (() => tailscaleAddress());
	let server: Server | undefined;
	let boundTo: string | undefined;
	let failedOn: string | undefined;

	const reconcile = () => {
		const next = address();
		if (next === boundTo) return;

		server?.close();
		server = undefined;
		boundTo = next;
		if (!next) return;

		const current = createDirectoryServer(options.readRuns ?? readLiveRuns);
		current.on("error", (error) => {
			// Another user's watchdog on a shared server already holds the port.
			// Logged once per address, retried when the address changes.
			if (failedOn !== next)
				options.log(
					`Tailnet directory unavailable on ${next}: ${error.message}`,
				);
			failedOn = next;
		});
		current.listen(port, next, () => {
			const { port: bound } = current.address() as AddressInfo;
			options.log(`Tailnet directory on http://${next}:${bound}/v1/runs`);
		});
		server = current;
	};

	reconcile();
	const timer = setInterval(reconcile, options.intervalMs);
	return () => {
		clearInterval(timer);
		server?.close();
	};
}
