import { rmSync } from "node:fs";
import { typedSwitch } from "hanzio";
import type { HostsOptions } from "../../types";
import {
	askChoice,
	claimFirstRunPrompt,
	declineMarker,
	isInteractive,
} from "../prompt";
import { hostsMode } from "../runtime-flags";
import { getCertNamesPath } from "./cert-names";
import { syncCertificateForRoutes } from "./certificates";
import {
	ensureHostsDaemonRunning,
	isHostsDaemonHealthy,
	isHostsDaemonWedged,
	SERVICE_START_TIMEOUT_MS,
} from "./daemon-client";
import { readDaemonConfig } from "./daemon-config";
import { cleanHostsFile } from "./hosts-file";
import {
	ensureMkcert,
	getCaPath,
	installTrust,
	isCaPresent,
	resolvedMkcertPath,
	uninstallTrust,
} from "./mkcert";
import { DECLINE_FILENAME } from "./paths";
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

const hostsDecline = declineMarker(DECLINE_FILENAME);

export function hasDeclinedHosts(): boolean {
	return hostsDecline.has();
}

export function persistHostsDecline(): void {
	hostsDecline.persist();
}

export function clearHostsDecline(): void {
	hostsDecline.clear();
}

type FirstRunChoice = "setup" | "skip" | "decline";

/**
 * The first-run setup question, unless another one was asked this run: that
 * is a skip, not a decline. `ask` is a test seam.
 */
export async function promptFirstRun(
	ask: () => Promise<FirstRunChoice> = askFirstRunSetup,
): Promise<FirstRunChoice> {
	if (!claimFirstRunPrompt()) return "skip";
	return ask();
}

async function askFirstRunSetup(): Promise<FirstRunChoice> {
	return askChoice(
		[
			"  buncargo needs one-time setup for named URLs (~10s, asks for your password)",
			"",
			"    • trust a local certificate authority (mkcert)",
			"    • run a loopback proxy on :443 so https://app.project.localhost works",
			"",
			"  Enter to set up  ·  s to skip this once  ·  n to use localhost:port from now on",
		],
		[
			{ key: "s", value: "skip" as const },
			{ key: "n", value: "decline" as const },
		],
		"setup",
	);
}

async function promptStaleService(reason: string): Promise<"update" | "skip"> {
	return askChoice(
		[
			`  ${reason}`,
			"",
			"  Updating it asks for your password (~10s). Until then the daemon keeps",
			"  running the older code, which can serve stale routes or certificates.",
			"",
			"  Enter to update  ·  s to skip this once",
		],
		[{ key: "s", value: "skip" as const }],
		"update",
	);
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
	try {
		rmSync(getCertNamesPath(), { force: true });
	} catch {
		// best-effort: an orphaned name list only widens a certificate
	}
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
	// Tailscale mode never reaches here, but must never install the daemon.
	if (hostsMode() !== "loopback") {
		return {
			ok: false,
			reason: "disabled",
			message:
				"Loopback named hosts are off (CI, BUNCARGO_HOSTS=0 or BUNCARGO_HOSTS=tailscale).",
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
	const serviceInstalled = isHostsServiceInstalled();
	const caPresent = isCaPresent();
	// Nothing installed at all is the one case that asks first: it is a
	// password prompt on a machine that has never seen buncargo. Repairing a
	// half-installed or stale setup does not, because the developer already
	// agreed to it and is now looking at named URLs that do not work.
	const firstRun = !serviceInstalled && !caPresent;

	if (!serviceInstalled || !caPresent || staleService) {
		// Installing prompts for a password. Without a TTY that would hang, so
		// report instead and let the run continue on localhost:port.
		//
		// The squatter lookup lists containers; only pay for it here, where the
		// message has to name whatever else is holding :443.
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
			// Undefined when the developer chose to set up now.
			const notNow: HostsEnableResult | undefined = typedSwitch(
				await promptFirstRun(),
				{
					setup: () => undefined,
					skip: () => ({
						ok: false,
						reason: "skipped",
						message: "Skipped named-hosts setup for this run.",
					}),
					decline: () => {
						persistHostsDecline();
						return {
							ok: false,
							reason: "declined",
							message:
								"Using localhost:port. Run `buncargo hosts install` to enable named URLs later.",
						};
					},
				},
			);
			if (notNow) return notNow;
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

	const ready = await ensureHostsDaemonRunning();
	if (!ready.ok) {
		return {
			ok: false,
			reason: "failed",
			message: ready.message ?? "Named-hosts daemon is not running.",
		};
	}
	return { ok: true, caPath: getCaPath(resolvedMkcertPath()) };
}

/**
 * What `doctor --fix` does about the named-hosts service.
 *
 * Installing needs a password, so without a terminal the fix is not made and
 * the reason is an issue, never a note: printed as done, it read as both fixed
 * and broken in one report.
 */
export function hostsServiceFix(input: {
	installed: boolean;
	stale: string | undefined;
	wedged: boolean;
	interactive: boolean;
}):
	| { action: "none" }
	| { action: "install"; note: string }
	| { action: "needs-terminal"; issue: string } {
	const { installed, stale, wedged, interactive } = input;
	if (installed && !stale && !wedged) return { action: "none" };
	if (!interactive) {
		const why =
			stale ??
			(wedged
				? "Named-hosts service is not serving its routes."
				: "Named-hosts service is not installed.");
		return {
			action: "needs-terminal",
			issue: `${why} Fixing it needs your password: run \`buncargo hosts install\` (or \`buncargo doctor --fix\`) in a terminal.`,
		};
	}
	const note = stale
		? "Reinstalled the named-hosts service after a stale install"
		: wedged
			? "Reloaded the named-hosts service, which was not serving its routes"
			: "Installed the named-hosts service";
	return { action: "install", note };
}

/** A named-hosts problem `doctor --fix` could not repair, by what it is about. */
export interface HostsFixIssue {
	kind: "ca" | "service" | "daemon" | "other";
	message: string;
}

/**
 * What `doctor --fix` repaired (`fixed`), and what it could not (`issues`):
 * typed, so doctor's own checks do not say the same thing a second time.
 */
export async function doctorFixHosts(
	options: { interactive?: boolean } = {},
): Promise<{ fixed: string[]; issues: HostsFixIssue[] }> {
	const fixed: string[] = [];
	const issues: HostsFixIssue[] = [];
	const interactive = options.interactive ?? isInteractive();
	try {
		const mkcertPath = await ensureMkcert();
		if (!isCaPresent(mkcertPath)) {
			if (!interactive) {
				issues.push({
					kind: "ca",
					message:
						"Named-hosts CA is not trusted, and trusting it needs a password. Run `buncargo hosts install` from a terminal.",
				});
				return { fixed, issues };
			}
			installTrust(mkcertPath);
			fixed.push("Trusted the local mkcert CA");
		}
		// A certificate that no longer covers the registered hostnames stops the
		// daemon binding, and the daemon cannot repair that itself.
		await syncCertificateForRoutes({ mkcertPath });
		const stale = describeStaleHostsService();
		const installed = isHostsServiceInstalled();
		// An installed service that is not answering is exactly the case doctor
		// exists to repair, so reload it rather than reporting it as fine. So is
		// one that answers with a route map it has stopped refreshing: it looks
		// healthy from the outside while every named URL 404s.
		const wedged = installed && !stale && (await isHostsDaemonWedged());
		const fix = hostsServiceFix({ installed, stale, wedged, interactive });
		const needsTerminal = typedSwitch(fix, "action", {
			none: () => false,
			install: ({ note }) => {
				installHostsService();
				fixed.push(note);
				return false;
			},
			"needs-terminal": ({ issue }) => {
				issues.push({ kind: "service", message: issue });
				return true;
			},
		});
		if (needsTerminal) return { fixed, issues };
		const ready = await ensureHostsDaemonRunning({
			timeoutMs: SERVICE_START_TIMEOUT_MS,
		});
		if (!ready.ok)
			issues.push({
				kind: "daemon",
				message: ready.message ?? "Named-hosts daemon is not running.",
			});
	} catch (error) {
		issues.push({ kind: "other", message: toHostsUserMessage(error) });
	}
	return { fixed, issues };
}
