import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { HostsOptions } from "../../types";
import { isHostsForcedOff } from "../runtime-flags";
import {
	ensureHostsDaemonRunning,
	isHostsDaemonHealthy,
	readDaemonConfig,
} from "./daemon";
import { cleanHostsFile } from "./hosts-file";
import {
	ensureMkcert,
	getCaPath,
	installTrust,
	isCaPresent,
	resolvedMkcertPath,
	uninstallTrust,
} from "./mkcert";
import { chownToInvokingUser, getDeclinePath, getHostsStateDir } from "./paths";
import { isHostsPlatformSupported } from "./plan";
import { removeHostRoutes } from "./registry";
import {
	installHostsService,
	isHostsServiceInstalled,
	uninstallHostsService,
} from "./service";
import { describePortSquatter } from "./squatter";

export type HostsEnableResult =
	| { ok: true; caPath?: string }
	| {
			ok: false;
			reason: "declined" | "skipped" | "unsupported" | "disabled" | "failed";
			message: string;
	  };

export function hasDeclinedHosts(): boolean {
	return existsSync(getDeclinePath());
}

export function persistHostsDecline(): void {
	mkdirSync(getHostsStateDir(), { recursive: true });
	const path = getDeclinePath();
	writeFileSync(path, `${new Date().toISOString()}\n`);
	chownToInvokingUser(path);
}

export function clearHostsDecline(): void {
	try {
		unlinkSync(getDeclinePath());
	} catch {
		// none
	}
}

function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptFirstRun(): Promise<"setup" | "skip" | "decline"> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(
			[
				"",
				"  buncargo needs one-time setup for named URLs (~10s, asks for your password)",
				"",
				"    • trust a local certificate authority (mkcert)",
				"    • run a loopback proxy on :443 so https://app.project.localhost works",
				"",
				"  Enter to set up  ·  s to skip this once  ·  n to use localhost:port from now on",
				"  > ",
			].join("\n"),
			resolve,
		);
	});
	rl.close();
	const normalized = answer.trim().toLowerCase();
	if (normalized === "s") return "skip";
	if (normalized === "n") return "decline";
	return "setup";
}

export async function runHostsInstall(): Promise<void> {
	clearHostsDecline();
	const mkcertPath = await ensureMkcert();
	if (!isCaPresent(mkcertPath)) {
		installTrust(mkcertPath);
	}
	if (!isHostsServiceInstalled()) {
		installHostsService();
	}
	const ready = await ensureHostsDaemonRunning({ allowSpawn: true });
	if (!ready.ok) {
		throw new Error(ready.message ?? "Named-hosts daemon failed to start");
	}
}

export async function runHostsUninstall(): Promise<void> {
	uninstallHostsService();
	uninstallTrust();
	try {
		cleanHostsFile();
	} catch {
		// may need sudo; best-effort
	}
	await removeHostRoutes(() => true);
	persistHostsDecline();
}

export async function ensureHostsReady(input: {
	hosts: boolean | HostsOptions | undefined;
	interactive?: boolean;
}): Promise<HostsEnableResult> {
	if (!input.hosts) {
		return {
			ok: false,
			reason: "disabled",
			message: "Named hosts are not enabled in config.",
		};
	}
	if (isHostsForcedOff()) {
		return {
			ok: false,
			reason: "disabled",
			message: "Named hosts disabled (CI or BUNCARGO_HOSTS=0).",
		};
	}
	if (!isHostsPlatformSupported()) {
		return {
			ok: false,
			reason: "unsupported",
			message: "Named hosts are supported on macOS and Linux only.",
		};
	}
	if (hasDeclinedHosts()) {
		return {
			ok: false,
			reason: "declined",
			message:
				"Named hosts were declined on this machine. Run `buncargo hosts install` to enable them.",
		};
	}

	if (await isHostsDaemonHealthy(readDaemonConfig().httpsPort)) {
		return { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
	}

	const squatter = describePortSquatter(readDaemonConfig().httpsPort);
	const interactive = input.interactive ?? isInteractive();
	if (!isHostsServiceInstalled() && !isCaPresent() && interactive) {
		const choice = await promptFirstRun();
		if (choice === "skip") {
			return {
				ok: false,
				reason: "skipped",
				message: "Skipped named-hosts setup for this run.",
			};
		}
		if (choice === "decline") {
			persistHostsDecline();
			return {
				ok: false,
				reason: "declined",
				message:
					"Using localhost:port. Run `buncargo hosts install` to enable named URLs later.",
			};
		}
		try {
			await runHostsInstall();
			return { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				reason: "failed",
				message: squatter ?? message,
			};
		}
	}

	const ready = await ensureHostsDaemonRunning({ allowSpawn: true });
	if (!ready.ok) {
		return {
			ok: false,
			reason: "failed",
			message:
				squatter ?? ready.message ?? "Named-hosts daemon is not running.",
		};
	}
	return { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
}

export async function doctorFixHosts(): Promise<string[]> {
	const notes: string[] = [];
	try {
		await ensureMkcert();
		if (!isCaPresent()) {
			installTrust();
			notes.push("Trusted the local mkcert CA");
		}
		if (!isHostsServiceInstalled()) {
			installHostsService();
			notes.push("Installed the named-hosts service");
		}
		const ready = await ensureHostsDaemonRunning({ allowSpawn: true });
		if (ready.ok) {
			notes.push("Named-hosts daemon is healthy");
		} else if (ready.message) {
			notes.push(ready.message);
		}
	} catch (error) {
		notes.push(error instanceof Error ? error.message : String(error));
	}
	return notes;
}
