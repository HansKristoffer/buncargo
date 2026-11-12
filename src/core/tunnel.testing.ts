import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in `cloudflared` that `BUNCARGO_CLOUDFLARED_PATH` points the real
 * quick-tunnel path at, so a test opens tunnels without the network.
 *
 * For each tunnel it prints `https://p<port>.trycloudflare.com` and runs
 * until closed. A port in `failPorts` exits as cloudflared does when it
 * cannot start; a port in `hangPorts` never prints a URL.
 */
export interface FakeCloudflared {
	/** The local URLs tunnels were asked for, in order. */
	opened: () => string[];
	/** Whether the tunnel process for `port` is still running. */
	running: (port: number) => boolean;
	/** Whether a tunnel process for `port` has started. */
	started: (port: number) => boolean;
	/** Puts the environment back and removes the stand-in. */
	restore: () => void;
}

export function fakeCloudflared(
	options: { failPorts?: number[]; hangPorts?: number[] } = {},
): FakeCloudflared {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-fake-cloudflared-"));
	const binary = join(dir, "cloudflared");
	const log = join(dir, "opened");
	const words = (ports: number[] = []) => ports.join(" ");
	writeFileSync(
		binary,
		`#!/bin/sh
url="$3"
port="\${url##*:}"
echo "$url" >> '${log}'
echo $$ > '${dir}/pid-'"$port"
case " ${words(options.failPorts)} " in *" $port "*) echo "failed to start" >&2; exit 1 ;; esac
case " ${words(options.hangPorts)} " in *" $port "*) exec sleep 600 ;; esac
echo "|  https://p$port.trycloudflare.com  |" >&2
exec sleep 600
`,
	);
	chmodSync(binary, 0o755);

	const saved = {
		path: process.env.BUNCARGO_CLOUDFLARED_PATH,
		stagger: process.env.BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS,
	};
	process.env.BUNCARGO_CLOUDFLARED_PATH = binary;
	process.env.BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS = "0";

	const pidOf = (port: number) => {
		const file = join(dir, `pid-${port}`);
		return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
	};
	return {
		opened: () =>
			existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
		started: (port) => pidOf(port) !== undefined,
		running: (port) => {
			const pid = pidOf(port);
			if (pid === undefined) return false;
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		restore: () => {
			restoreEnv("BUNCARGO_CLOUDFLARED_PATH", saved.path);
			restoreEnv("BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS", saved.stagger);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
