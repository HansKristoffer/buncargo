import {
	createTailscaleClient,
	type TailscaleCommand,
	tailnetStatus,
	tailscaleBinary,
} from "./client";
import {
	DIRECTORY_PORT,
	parseDirectory,
	type RemoteRun,
	readDirectory,
} from "./protocol";

/** Probe only Tailscale's authenticated peer list, with bounded concurrency and an overall deadline. */
export async function discoverTailnet(
	command?: TailscaleCommand,
	request: (url: string, options: RequestInit) => Promise<Response> = fetch,
) {
	const binary = tailscaleBinary();
	if (!command && !binary)
		return {
			version: 1,
			configured: false,
			generatedAt: Date.now(),
			runs: [],
			notice:
				"Install and sign in to Tailscale to discover remote environments.",
		};
	const status = await tailnetStatus(
		command ?? createTailscaleClient(binary as string),
	);
	const peers = status.peers
		.filter((p) => p.online && p.id !== status.self.id)
		.slice(0, 100);
	const runs: RemoteRun[] = [];
	let next = 0;
	const deadline = AbortSignal.timeout(12000);
	await Promise.all(
		Array.from({ length: Math.min(8, peers.length) }, async () => {
			for (;;) {
				const peer = peers[next++];
				if (!peer || deadline.aborted) return;
				try {
					const response = await request(
						`https://${peer.hostname}:${DIRECTORY_PORT}/v1/runs`,
						{
							signal: AbortSignal.any([deadline, AbortSignal.timeout(2500)]),
							redirect: "error",
						},
					);
					const directory = parseDirectory(await readDirectory(response), peer);
					runs.push(...directory.runs);
				} catch {
					/* Other tailnet peers need not run Buncargo or permit access. */
				}
			}
		}),
	);
	return {
		version: 1,
		configured: true,
		generatedAt: Date.now(),
		runs: runs
			.slice(0, 100)
			.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
	};
}
