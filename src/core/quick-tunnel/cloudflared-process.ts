/**
 * Spawn cloudflared and parse the quick-tunnel public URL from output.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolvedCloudflaredBinPath } from "./constants";

/** Primary: ASCII box line from cloudflared (`|  https://…  |`). */
const urlRegexPipe = /\|\s+(https?:\/\/\S+)/;
/** Fallback: URL may appear without the leading pipe if logs wrap or format changes. */
const urlRegexTryCloudflare =
	/(https:\/\/[a-zA-Z0-9][-a-zA-Z0-9.]*\.trycloudflare\.com)\b/;

const MAX_CAPTURED_LOG = 24_000;

/** Default 30s; set `BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS=0` to disable. */
export function resolveQuickTunnelUrlTimeoutMs(): number {
	const raw = process.env.BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS;
	if (raw === undefined || raw === "") {
		return 30_000;
	}
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

export function parseQuickTunnelUrlFromOutput(log: string): string | null {
	const pipe = log.match(urlRegexPipe);
	if (pipe?.[1]) {
		return pipe[1];
	}
	const direct = log.match(urlRegexTryCloudflare);
	return direct?.[1] ?? null;
}

export function startCloudflaredTunnel(
	options: Record<string, string | number | null>,
): {
	url: Promise<string>;
	child: ChildProcess;
	stop: () => boolean;
} {
	const args: string[] = ["tunnel"];
	for (const [key, value] of Object.entries(options)) {
		if (typeof value === "string") {
			args.push(`${key}`, value);
		} else if (typeof value === "number") {
			args.push(`${key}`, value.toString());
		} else if (value === null) {
			args.push(`${key}`);
		}
	}
	if (args.length === 1) {
		args.push("--url", "localhost:8080");
	}

	const binPath = resolvedCloudflaredBinPath();
	const child = spawn(binPath, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (process.env.DEBUG) {
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);
	}

	let settled = false;
	let urlResolver!: (value: string | PromiseLike<string>) => void;
	let urlRejector!: (reason: unknown) => void;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const clearUrlTimeout = () => {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
	};

	const url = new Promise<string>((resolve, reject) => {
		urlResolver = (v) => {
			if (!settled) {
				settled = true;
				clearUrlTimeout();
				resolve(v);
			}
		};
		urlRejector = (e) => {
			if (!settled) {
				settled = true;
				clearUrlTimeout();
				reject(e);
			}
		};

		const timeoutMs = resolveQuickTunnelUrlTimeoutMs();
		if (timeoutMs > 0) {
			timeoutId = setTimeout(() => {
				try {
					child.kill("SIGINT");
				} catch {
					/* ignore */
				}
				urlRejector(
					new Error(
						`quick tunnel URL timed out after ${timeoutMs}ms (no public URL from cloudflared)`,
					),
				);
			}, timeoutMs);
		}
	});

	const log: { buf: string } = { buf: "" };
	const append = (data: Buffer) => {
		log.buf += data.toString();
		if (log.buf.length > MAX_CAPTURED_LOG) {
			log.buf = log.buf.slice(-MAX_CAPTURED_LOG);
		}
		const url = parseQuickTunnelUrlFromOutput(log.buf);
		if (url) {
			urlResolver(url);
		}
	};
	child.stdout?.on("data", append).on("error", urlRejector);
	child.stderr?.on("data", append).on("error", urlRejector);

	child.on("exit", (code, signal) => {
		if (!settled) {
			const tail = log.buf.trimEnd();
			const excerpt = tail.length > 1200 ? `…${tail.slice(-1200)}` : tail;
			const detail = excerpt ? `\ncloudflared output (tail):\n${excerpt}` : "";
			urlRejector(
				new Error(
					`cloudflared exited before a tunnel URL was parsed (code=${code}, signal=${signal ?? "none"}). ` +
						`Parallel quick-tunnel requests are often rate-limited; buncargo starts tunnels sequentially with a short pause. ` +
						`If this persists, try fewer expose targets or increase BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS.${detail}`,
				),
			);
		}
	});
	child.on("error", urlRejector);

	const stop = () => child.kill("SIGINT");

	return { url, child, stop };
}
