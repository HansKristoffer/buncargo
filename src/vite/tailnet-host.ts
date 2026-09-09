import {
	createTailscaleClient,
	tailnetStatus,
	tailscaleBinary,
} from "../core/tailnet/client";
import {
	coordinatorStatePath,
	readCoordinatorState,
} from "../core/tailnet/coordinator-state";

/** The Vite lifecycle surface needed to reload config after cloud enrollment. */
export interface ViteHostServer {
	watcher: {
		add(path: string): unknown;
		on(event: "add" | "change", listener: (path: string) => void): unknown;
		off(event: "add" | "change", listener: (path: string) => void): unknown;
	};
	httpServer: {
		listening: boolean;
		once(event: "close" | "listening", listener: () => void): unknown;
	} | null;
	restart(): Promise<void>;
	config: { logger: { error(message: string): void } };
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

/** Resolve before Vite freezes host validation; late enrollment requires a config reload. */
export function createTailnetHostAccess(resolveHostname = localHostname) {
	let hostname: string | undefined;
	const resolve = () => resolveHostname().catch(() => undefined);
	return {
		async allowedHosts() {
			hostname = await resolve();
			return hostname ? [hostname] : [];
		},
		watch(server: ViteHostServer) {
			if (hostname || !server.httpServer) return;
			const path = coordinatorStatePath();
			let closed = false;
			let checking = false;
			const stop = () => {
				closed = true;
				server.watcher.off("add", changed);
				server.watcher.off("change", changed);
			};
			const check = async () => {
				if (closed || checking || !server.httpServer?.listening) return;
				checking = true;
				try {
					const current = await resolve();
					if (closed || !current) return;
					stop();
					await server.restart();
				} catch {
					server.config.logger.error(
						"Could not reload Vite after Tailscale sign-in. Restart the dev server.",
					);
				} finally {
					checking = false;
				}
			};
			const changed = (file: string) => {
				if (file === path) void check();
			};
			// Reuse Vite's watcher, including when the coordinator file doesn't exist
			// yet. Local-only dev runs do not need a polling timer or CLI probes.
			server.watcher.add(path);
			server.watcher.on("add", changed);
			server.watcher.on("change", changed);
			server.httpServer.once("close", stop);
			server.httpServer.once("listening", () => void check());
			void check();
		},
	};
}
