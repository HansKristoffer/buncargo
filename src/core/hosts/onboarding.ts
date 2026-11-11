import { rmSync } from "node:fs";
import { getErrorMessage, typedSwitch } from "hanzio";
import type { HostsOptions } from "../../types";
import {
	askChoice,
	claimFirstRunPrompt,
	declineMarker,
	isInteractive,
} from "../prompt";
import { hostsMode } from "../runtime-flags";
import { getCertNamesPath } from "./cert-names";
import { machineMkcert, syncCertificateForRoutes } from "./certificates";
import {
	ensureHostsDaemonRunning,
	hostsDaemonProbe,
	isHostsDaemonHealthy,
	isHostsDaemonWedged,
	SERVICE_START_TIMEOUT_MS,
} from "./daemon-client";
import {
	cleanHostsFileAsRoot,
	DEFAULT_HOSTS_FILE,
	HOSTS_BLOCK_END,
	HOSTS_BLOCK_START,
} from "./hosts-file";
import {
	ensureMkcert,
	getCaPath,
	installTrust,
	isCaTrusted,
	resolvedMkcertPath,
	uninstallTrust,
} from "./mkcert";
import { DECLINE_FILENAME } from "./paths";
import { isHostsPlatformSupported } from "./plan";
import { systemPrivilegedRunner } from "./privileged";
import { HOSTS_HTTPS_PORT } from "./protocol";
import { clearHostRoutes } from "./registry";
import {
	describeStaleHostsService,
	installHostsService,
	isHostsServiceInstalled,
	machineServiceInstall,
	readHostsServiceManifest,
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

function clearHostsDecline(): void {
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
	/** Resolves to notes worth showing, such as a newer service it kept. */
	reinstall: () => Promise<string[]>;
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
		const notes = await deps.reinstall();
		return {
			ok: true,
			caPath: deps.caPath(),
			...(notes.length === 0 ? {} : { notes }),
		};
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
		/** Install over a newer service too (`hosts install --force`). */
		force?: boolean;
	} = {},
): Promise<string[]> {
	clearHostsDecline();
	const mkcertPath = await ensureMkcert();
	// Unconditionally: `hosts uninstall` removes the trust and keeps the CA
	// files, so "the CA exists" skipped this on the reinstall that needed it.
	// `mkcert -install` asks for nothing when the CA is already trusted.
	installTrust(mkcertPath);
	// Mint before the service starts. The daemon cannot bind :443 without a
	// leaf, and it will not mint one itself.
	await syncCertificateForRoutes(machineMkcert);
	const notes: string[] = [];
	if (
		options.reinstallService ||
		!isHostsServiceInstalled() ||
		describeStaleHostsService()
	) {
		const { kept } = installHostsService({
			...machineServiceInstall(),
			force: options.force,
		});
		if (kept) notes.push(kept);
	}
	const ready = await ensureHostsDaemonRunning(hostsDaemonProbe(), {
		timeoutMs: SERVICE_START_TIMEOUT_MS,
	});
	if (!ready.ok) {
		throw new Error(ready.message ?? "Named-hosts daemon failed to start");
	}
	return notes;
}

/** The steps of `hosts uninstall`, injected so the order can be tested without root. */
export interface HostsUninstallDeps {
	removeService: () => void;
	removeTrust: () => void;
	cleanHostsFile: () => void;
	clearRoutes: () => Promise<void>;
	removeCertNames: () => void;
	persistDecline: () => void;
}

/**
 * Take named hosts off this machine, returning what it could not do.
 *
 * Cleaning `/etc/hosts` needs `sudo` once the root daemon that wrote the block
 * is gone, and with no terminal to ask for a password it fails. Thrown, that
 * stopped here with the trust already removed and the routes and the decline
 * never written, so the next `buncargo dev` set everything up again.
 */
export async function uninstallHosts(
	deps: HostsUninstallDeps,
): Promise<string[]> {
	const warnings: string[] = [];
	deps.removeService();
	deps.removeTrust();
	// As root when needed: the daemon that wrote the block is stopped now, and
	// the block left behind points every hostname at a proxy that is gone.
	try {
		deps.cleanHostsFile();
	} catch (error) {
		const message = `Could not remove buncargo's block from ${DEFAULT_HOSTS_FILE} (${getErrorMessage(error)}); its hostnames still point at 127.0.0.1. Run \`buncargo hosts uninstall\` again from a terminal, or delete the lines from \`${HOSTS_BLOCK_START}\` to \`${HOSTS_BLOCK_END}\` with \`sudo $EDITOR ${DEFAULT_HOSTS_FILE}\`.`;
		warnings.push(message);
	}
	await deps.clearRoutes();
	deps.removeCertNames();
	deps.persistDecline();
	return warnings;
}

export function runHostsUninstall(): Promise<string[]> {
	const runner = systemPrivilegedRunner();
	return uninstallHosts({
		removeService: () => uninstallHostsService(runner),
		removeTrust: () => uninstallTrust(),
		cleanHostsFile: () => cleanHostsFileAsRoot(runner),
		clearRoutes: () => clearHostRoutes(),
		removeCertNames: () => {
			try {
				rmSync(getCertNamesPath(), { force: true });
			} catch {
				// best-effort: an orphaned name list only widens a certificate
			}
		},
		persistDecline: persistHostsDecline,
	});
}

/**
 * Whether setting up named hosts asks first.
 *
 * A machine buncargo never installed the service on is the one case: it is a
 * password prompt nobody agreed to. A CA that exists says nothing about that,
 * since mkcert is used by other tools, and counting it skipped the question.
 * Repairing a half-installed or stale setup does not ask, because the
 * developer already agreed and is now looking at named URLs that do not work.
 */
export function setupNeedsConsent(input: {
	serviceInstalled: boolean;
	/** A service manifest exists: buncargo installed it here before. */
	everInstalled: boolean;
}): boolean {
	return !input.serviceInstalled && !input.everInstalled;
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

	if (await isHostsDaemonHealthy()) {
		// Healthy is not the same as usable: a daemon below this CLI's protocol
		// answers health checks, and only a reinstall can move it.
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
	const caTrusted = isCaTrusted();
	const firstRun = setupNeedsConsent({
		serviceInstalled,
		everInstalled: readHostsServiceManifest() !== undefined,
	});

	if (!serviceInstalled || !caTrusted || staleService) {
		// Installing prompts for a password. Without a TTY that would hang, so
		// report instead and let the run continue on localhost:port.
		//
		// The squatter lookup lists containers; only pay for it here, where the
		// message has to name whatever else is holding :443.
		const squatter = describePortSquatter(HOSTS_HTTPS_PORT);
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
			const notes = await runHostsInstall();
			return {
				ok: true,
				caPath: getCaPath(resolvedMkcertPath()),
				...(notes.length === 0 ? {} : { notes }),
			};
		} catch (error) {
			return {
				ok: false,
				reason: "failed",
				message: squatter ?? toHostsUserMessage(error),
			};
		}
	}

	const ready = await ensureHostsDaemonRunning(hostsDaemonProbe());
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
	// A choice, not a fault: `buncargo hosts install` is how it is undone, and
	// doctor says so rather than asking for a password to set up something
	// every run would go on ignoring.
	if (hasDeclinedHosts()) return { fixed, issues };
	try {
		const mkcertPath = await ensureMkcert();
		if (!isCaTrusted(mkcertPath)) {
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
		await syncCertificateForRoutes(machineMkcert);
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
				const { kept } = installHostsService(machineServiceInstall());
				if (kept) issues.push({ kind: "service", message: kept });
				else fixed.push(note);
				return false;
			},
			"needs-terminal": ({ issue }) => {
				issues.push({ kind: "service", message: issue });
				return true;
			},
		});
		if (needsTerminal) return { fixed, issues };
		const ready = await ensureHostsDaemonRunning(hostsDaemonProbe(), {
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
