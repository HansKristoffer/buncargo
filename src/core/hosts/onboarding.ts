import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { HostsOptions } from "../../types";
import { isHostsForcedOff } from "../runtime-flags";
import { syncCertificateForRoutes } from "./certificates";
import {
	ensureHostsDaemonRunning,
	isHostsDaemonHealthy,
	readDaemonConfig,
	SERVICE_START_TIMEOUT_MS,
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
	describeStaleHostsService,
	installHostsService,
	isHostsServiceInstalled,
	toHostsUserMessage,
	uninstallHostsService,
} from "./service";
import { describePortSquatter } from "./squatter";

export type HostsEnableResult =
	| {
			ok: true;
			caPath?: string;
			/** Non-fatal conditions worth telling the user about. */
			notes?: string[];
	  }
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

async function promptStaleService(reason: string): Promise<"update" | "skip"> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(
			[
				"",
				`  ${reason}`,
				"",
				"  Updating it asks for your password (~10s). Until then the daemon keeps",
				"  running the older code, which can serve stale routes or certificates.",
				"",
				"  Enter to update  ·  s to skip this once",
				"  > ",
			].join("\n"),
			resolve,
		);
	});
	rl.close();
	return answer.trim().toLowerCase() === "s" ? "skip" : "update";
}

export interface StaleServiceRepairDeps {
	/** Undefined when there is no TTY to prompt on. */
	prompt?: (reason: string) => Promise<"update" | "skip">;
	reinstall: () => Promise<void>;
	caPath: () => string | undefined;
}

/**
 * Repair a service that answers on :443 but runs the wrong code.
 *
 * A stale service is not a failure — it is serving — so this cannot abort the
 * run. But it also cannot be silent: reinstalling needs `sudo`, so the daemon
 * has no way to update itself, and left as a passive warning it just fills
 * `/var/log/buncargo-hosts.log` with reload failures for whatever the old bundle
 * cannot handle. Every edge is injected so the branching is testable without a
 * password prompt.
 */
export async function repairStaleService(
	staleService: string,
	deps: StaleServiceRepairDeps,
): Promise<HostsEnableResult> {
	const asIs: HostsEnableResult = {
		ok: true,
		caPath: deps.caPath(),
		notes: [staleService],
	};
	if (!deps.prompt) return asIs;
	if ((await deps.prompt(staleService)) === "skip") return asIs;
	try {
		await deps.reinstall();
		return { ok: true, caPath: deps.caPath() };
	} catch (error) {
		// The old daemon is still up, so the run continues on named hosts either
		// way; only the reason it is stale changes.
		return { ...asIs, notes: [toHostsUserMessage(error)] };
	}
}

export async function runHostsInstall(
	options: {
		/**
		 * Rewrite and reload the service even when one is already installed.
		 *
		 * Set by the explicit `buncargo hosts install` command. Without it a
		 * service that is installed but broken — wrong code, wedged daemon —
		 * looks fine to `isHostsServiceInstalled()`, so the command that is meant
		 * to repair it would skip the only step that could.
		 */
		reinstallService?: boolean;
	} = {},
): Promise<void> {
	clearHostsDecline();
	const mkcertPath = await ensureMkcert();
	if (!isCaPresent(mkcertPath)) {
		installTrust(mkcertPath);
	}
	// Mint before the service starts. The daemon cannot bind :443 without a
	// leaf, and it will not mint one itself.
	await syncCertificateForRoutes({ mkcertPath });
	if (
		options.reinstallService ||
		!isHostsServiceInstalled() ||
		describeStaleHostsService()
	) {
		installHostsService();
	}
	const ready = await ensureHostsDaemonRunning({
		allowSpawn: true,
		timeoutMs: SERVICE_START_TIMEOUT_MS,
	});
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

	const interactive = input.interactive ?? isInteractive();

	if (await isHostsDaemonHealthy(readDaemonConfig().httpsPort)) {
		// Healthy is not the same as current: a daemon loaded from a previous
		// version's bundle answers health checks while running that version's
		// code, and only an explicit reinstall can move it.
		const stale = describeStaleHostsService();
		return stale
			? await repairStaleService(stale, {
					prompt: interactive ? promptStaleService : undefined,
					reinstall: () => runHostsInstall({ reinstallService: true }),
					caPath: () => getCaPath(resolvedMkcertPath()),
				})
			: { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
	}

	const staleService = describeStaleHostsService();
	const firstRun = !isHostsServiceInstalled() && !isCaPresent();
	const needsMachineSetup =
		firstRun ||
		!isHostsServiceInstalled() ||
		!isCaPresent() ||
		staleService !== undefined;

	if (needsMachineSetup) {
		// Installing prompts for a password. Without a TTY that would hang, so
		// report instead and let the run continue on localhost:port.
		// Squatter lookup shells out to docker ps; only pay for it on this
		// path, where the message needs to name whatever is holding :443.
		const squatter = describePortSquatter(readDaemonConfig().httpsPort);
		if (!interactive) {
			return {
				ok: false,
				reason: "failed",
				message:
					staleService ??
					squatter ??
					"Named hosts need one-time setup. Run `buncargo hosts install`.",
			};
		}
		if (firstRun) {
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
		}
		try {
			await runHostsInstall();
			return { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
		} catch (error) {
			return {
				ok: false,
				reason: "failed",
				message: squatter ?? toHostsUserMessage(error),
			};
		}
	}

	const ready = await ensureHostsDaemonRunning({ allowSpawn: true });
	if (!ready.ok) {
		return {
			ok: false,
			reason: "failed",
			message: ready.message ?? "Named-hosts daemon is not running.",
		};
	}
	return { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
}

export async function doctorFixHosts(
	options: { interactive?: boolean } = {},
): Promise<string[]> {
	const notes: string[] = [];
	const interactive = options.interactive ?? isInteractive();
	try {
		const mkcertPath = await ensureMkcert();
		if (!isCaPresent(mkcertPath)) {
			if (!interactive) {
				notes.push(
					"Named-hosts CA is not trusted, and trusting it needs a password. Run `buncargo hosts install` from a terminal.",
				);
				return notes;
			}
			installTrust(mkcertPath);
			notes.push("Trusted the local mkcert CA");
		}
		// A certificate that no longer covers the registered hostnames stops the
		// daemon binding, and the daemon cannot repair that itself.
		await syncCertificateForRoutes({ mkcertPath });
		const stale = describeStaleHostsService();
		const installed = isHostsServiceInstalled();
		// An installed service that is not answering is exactly the case doctor
		// exists to repair, so reload it rather than reporting it as fine.
		const wedged = installed && !stale && !(await isHostsDaemonHealthy());
		if (!installed || stale || wedged) {
			if (!interactive) {
				notes.push(
					stale ??
						"Named-hosts service needs a password to install. Run `buncargo hosts install` from a terminal.",
				);
				return notes;
			}
			installHostsService();
			if (stale) {
				notes.push("Reinstalled the named-hosts service after a stale install");
			} else if (wedged) {
				notes.push("Reloaded the named-hosts service, which was not answering");
			} else {
				notes.push("Installed the named-hosts service");
			}
		}
		const ready = await ensureHostsDaemonRunning({
			allowSpawn: true,
			timeoutMs: SERVICE_START_TIMEOUT_MS,
		});
		if (ready.ok) {
			notes.push("Named-hosts daemon is healthy");
		} else if (ready.message) {
			notes.push(ready.message);
		}
	} catch (error) {
		notes.push(toHostsUserMessage(error));
	}
	return notes;
}
