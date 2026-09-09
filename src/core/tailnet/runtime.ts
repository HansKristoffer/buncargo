import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortableSleep } from "../deadline";
import { installTailscale } from "./binary";
import { startGuardedChild } from "./child-guard";
import {
	createTailscaleClient,
	type TailscaleCommand,
	tailnetStatus,
	tailscaleBinary,
} from "./client";

export interface TailnetRuntime {
	command: TailscaleCommand;
	binary: string;
	socket?: string;
	close(): Promise<void>;
}

const runtimeDependencies = {
	binary: tailscaleBinary,
	install: installTailscale,
	command: createTailscaleClient,
};

/** Adopt an existing login without changing it. Otherwise own one ephemeral userspace node. */
export async function startTailnetRuntime(
	authKey: string | undefined,
	signal: AbortSignal,
	overrides: Partial<typeof runtimeDependencies> = {},
): Promise<TailnetRuntime> {
	const deps = { ...runtimeDependencies, ...overrides };
	const existing = deps.binary();
	if (existing) {
		const command = deps.command(existing);
		try {
			await tailnetStatus(command, signal);
			return { command, binary: existing, async close() {} };
		} catch {
			signal.throwIfAborted();
			if (!authKey)
				throw new Error(
					"Tailscale is installed but unavailable. Sign in and grant this user permission to run tailscale serve.",
				);
		}
	}
	if (!authKey)
		throw new Error(
			"Install and sign in to Tailscale, or set TS_AUTHKEY in your cloud environment secrets",
		);
	const { binary, daemon } = await deps.install(signal);
	const directory = await mkdtemp(join(tmpdir(), "bc-ts-"));
	const socket = join(directory, "tailscaled.sock");
	const secretFile = join(directory, "auth-key");
	const child = startGuardedChild(
		daemon,
		[
			"--tun=userspace-networking",
			"--state=mem:",
			// TLS certificates need a writable cache even when node identity stays in memory.
			`--statedir=${directory}`,
			`--socket=${socket}`,
		],
		directory,
	);
	const close = async () => {
		await child.close();
		await rm(directory, { recursive: true, force: true });
	};
	const command = deps.command(binary, socket);
	try {
		for (let i = 0; ; i++) {
			signal.throwIfAborted();
			if (!child.alive || i >= 50)
				throw new Error("Tailscale userspace daemon did not start");
			try {
				await command(["status", "--json"], signal);
				break;
			} catch {
				await abortableSleep(100, signal);
			}
		}
		// file: keeps the key out of argv, process listings and error text; the private temp is deleted immediately.
		await writeFile(secretFile, authKey, { mode: 0o600, flag: "wx" });
		await command(
			[
				"up",
				`--auth-key=file:${secretFile}`,
				`--hostname=buncargo-${crypto.randomUUID().slice(0, 12)}`,
				"--accept-dns=false",
				"--accept-routes=false",
				"--timeout=15s",
			],
			signal,
		);
		await rm(secretFile, { force: true });
		await tailnetStatus(command, signal);
		return { command, binary, socket, close };
	} catch (error) {
		await close();
		throw error;
	}
}
