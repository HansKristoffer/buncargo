import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortableSleep } from "../deadline";
import { tailscaleProcessEnv } from "../runtime-flags";
import { installTailscale } from "./binary";
import { CHILD_GUARD } from "./child-guard";
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
	const child = spawn(
		process.execPath,
		[
			"-e",
			CHILD_GUARD,
			"--",
			directory,
			daemon,
			"--tun=userspace-networking",
			"--state=mem:",
			`--socket=${socket}`,
		],
		{
			env: tailscaleProcessEnv(),
			stdio: ["pipe", "ignore", "ignore"],
		},
	);
	let exited = false;
	const finished = new Promise<void>((resolve) => {
		child.once("exit", () => {
			exited = true;
			resolve();
		});
		child.once("error", () => {
			exited = true;
			resolve();
		});
	});
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			if (!exited) {
				child.stdin?.end();
				const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
				try {
					await finished;
				} finally {
					clearTimeout(timer);
				}
			}
			await rm(directory, { recursive: true, force: true });
		})();
		return closing;
	};
	const command = deps.command(binary, socket);
	try {
		for (let i = 0; ; i++) {
			signal.throwIfAborted();
			if (exited || i >= 50)
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
