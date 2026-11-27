import net from "node:net";

/**
 * Probe whether something is accepting TCP connections on `port`.
 *
 * Kept in a zero-dependency leaf so the root hosts daemon and connect daemon
 * do not pull `core/network.ts` (`style.ts` / `picocolors`) into their
 * standalone bundles.
 *
 * This answers "is it reachable", not "who owns it". For ownership decisions
 * (reuse/kill/fail) use `getPortOwner` from `core/process`, which inspects
 * listening PIDs and Docker labels instead.
 */
export function isTcpPortOpen(
	port: number,
	host = "127.0.0.1",
	timeoutMs = 1000,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);

		const socket = net.connect({ port, host });
		const finish = (open: boolean) => {
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
			socket.destroy();
			resolve(open);
		};
		const onAbort = () => finish(false);

		signal?.addEventListener("abort", onAbort, { once: true });
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}
