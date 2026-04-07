/**
 * Spawn cloudflared and parse the quick-tunnel public URL from output.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cloudflaredBinPath } from "./constants";

const urlRegex = /\|\s+(https?:\/\/\S+)/;

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

	const child = spawn(cloudflaredBinPath, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (process.env.DEBUG) {
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);
	}

	let settled = false;
	let urlResolver!: (value: string | PromiseLike<string>) => void;
	let urlRejector!: (reason: unknown) => void;
	const url = new Promise<string>((resolve, reject) => {
		urlResolver = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		urlRejector = (e) => {
			if (!settled) {
				settled = true;
				reject(e);
			}
		};
	});

	const parser = (data: Buffer) => {
		const str = data.toString();

		const urlMatch = str.match(urlRegex);
		if (urlMatch) {
			urlResolver(urlMatch[1] ?? "");
		}
	};
	child.stdout?.on("data", parser).on("error", urlRejector);
	child.stderr?.on("data", parser).on("error", urlRejector);

	child.on("exit", (code, signal) => {
		if (!settled) {
			urlRejector(
				new Error(
					`cloudflared exited before a tunnel URL was parsed (code=${code}, signal=${signal ?? "none"})`,
				),
			);
		}
	});
	child.on("error", urlRejector);

	const stop = () => child.kill("SIGINT");

	return { url, child, stop };
}
