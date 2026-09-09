import type { IncomingMessage, ServerResponse } from "node:http";
import {
	createTailscaleClient,
	tailnetStatus,
	tailscaleBinary,
} from "../core/tailnet/client";
import { readCoordinatorState } from "../core/tailnet/coordinator-state";

/** The Vite surface needed to extend host checks before its internal middleware runs. */
export interface ViteHostServer {
	config: { server: { allowedHosts: string[] | true } };
	middlewares: {
		use(
			middleware: (
				req: IncomingMessage,
				res: ServerResponse,
				next: () => void,
			) => void,
		): unknown;
	};
}

/** Read the authenticated local node, including an isolated cloud coordinator's socket. */
async function localHostname(): Promise<string | undefined> {
	const connection = (await readCoordinatorState())?.connection;
	const binary = connection?.binary ?? tailscaleBinary();
	if (!binary) return;
	const status = await tailnetStatus(
		createTailscaleClient(binary, connection?.socket),
		AbortSignal.timeout(2000),
	);
	return status.self.hostname;
}

/**
 * Enrollment may finish after Vite starts. Resolve on the first Tailscale request
 * instead of freezing the hostname at config time. Never trust the request itself
 * or allow all of .ts.net; only the local authenticated node can extend the list.
 */
export function allowTailnetHost(
	server: ViteHostServer,
	resolveHostname = localHostname,
) {
	let lookup: Promise<string | undefined> | undefined;
	let expiresAt = 0;
	server.middlewares.use((req, _res, next) => {
		const host = req.headers.host?.split(":")[0]?.toLowerCase();
		const allowed = server.config.server.allowedHosts;
		if (
			!host?.endsWith(".ts.net") ||
			allowed === true ||
			allowed.includes(host)
		) {
			next();
			return;
		}
		// Share one bounded lookup across parallel module requests. Failed lookups
		// expire too, so a node that signs in later works without restarting Vite.
		if (!lookup || Date.now() >= expiresAt) {
			expiresAt = Number.POSITIVE_INFINITY;
			lookup = resolveHostname()
				.catch(() => undefined)
				.finally(() => {
					expiresAt = Date.now() + 2000;
				});
		}
		void lookup.then((hostname) => {
			if (hostname === host && !allowed.includes(host)) allowed.push(host);
			next();
		});
	});
}
