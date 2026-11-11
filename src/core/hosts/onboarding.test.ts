import { afterEach, describe, expect, it } from "bun:test";
import { claimFirstRunPrompt, resetFirstRunPrompt } from "../prompt";
import { useTempHome } from "../test-env.testing";
import {
	doctorFixHosts,
	type HostsInstallDeps,
	hostsServiceFix,
	installHosts,
	persistHostsDecline,
	promptFirstRun,
	repairStaleService,
	setupNeedsConsent,
	uninstallHosts,
} from "./onboarding";

const REASON =
	"Named-hosts service runs buncargo 15.1.0 (protocol 1), older than this buncargo needs (protocol 2). Run `buncargo hosts install` to update it.";

describe("repairStaleService", () => {
	// The stale daemon is still serving, so this path must never fail the run —
	// only tell the user what will bite them and how to fix it.
	it("carries the reason as a note when there is no TTY to prompt on", async () => {
		let reinstalls = 0;
		const result = await repairStaleService(REASON, {
			reinstall: async () => {
				reinstalls += 1;
				return [];
			},
			caPath: () => "/ca.pem",
		});
		expect(result).toEqual({ ok: true, caPath: "/ca.pem", notes: [REASON] });
		expect(reinstalls).toBe(0);
	});

	it("reinstalls when the prompt is accepted and drops the note", async () => {
		const prompted: string[] = [];
		let reinstalls = 0;
		const result = await repairStaleService(REASON, {
			prompt: async (reason) => {
				prompted.push(reason);
				return "update";
			},
			reinstall: async () => {
				reinstalls += 1;
				return [];
			},
			caPath: () => "/ca.pem",
		});
		expect(prompted).toEqual([REASON]);
		expect(reinstalls).toBe(1);
		expect(result).toEqual({ ok: true, caPath: "/ca.pem" });
	});

	it("keeps the note and skips the password prompt when declined", async () => {
		let reinstalls = 0;
		const result = await repairStaleService(REASON, {
			prompt: async () => "skip",
			reinstall: async () => {
				reinstalls += 1;
				return [];
			},
			caPath: () => "/ca.pem",
		});
		expect(reinstalls).toBe(0);
		expect(result.ok).toBe(true);
		expect(result.ok && result.notes).toEqual([REASON]);
	});

	// The update found a newer service another project installed and kept
	// it: the run goes on, and says so.
	it("carries what the reinstall kept as its note", async () => {
		const kept = "Kept the named-hosts service from buncargo 17.0.0";
		const result = await repairStaleService(REASON, {
			prompt: async () => "update",
			reinstall: async () => [kept],
			caPath: () => "/ca.pem",
		});
		expect(result).toEqual({ ok: true, caPath: "/ca.pem", notes: [kept] });
	});

	// A failed reinstall leaves the old daemon serving, so the run continues
	// with named hosts; only the reason reported changes.
	it("reports the failure and stays usable when the reinstall fails", async () => {
		const result = await repairStaleService(REASON, {
			prompt: async () => "update",
			reinstall: async () => {
				throw new Error("sudo: a password is required");
			},
			caPath: () => "/ca.pem",
		});
		expect(result.ok).toBe(true);
		expect(result.ok && result.notes).toEqual(["sudo: a password is required"]);
	});
});

describe("promptFirstRun", () => {
	afterEach(resetFirstRunPrompt);

	// One first-run question per run: the menu bar offer comes next in `dev`.
	it("takes the run's first-run prompt slot when it asks", async () => {
		expect(await promptFirstRun(async () => "decline")).toBe("decline");
		expect(claimFirstRunPrompt()).toBe(false);
	});

	it("skips without asking when another prompt already took the slot", async () => {
		claimFirstRunPrompt();
		let asked = false;
		const choice = await promptFirstRun(async () => {
			asked = true;
			return "setup";
		});
		expect(choice).toBe("skip");
		expect(asked).toBe(false);
	});
});

describe("setupNeedsConsent", () => {
	// mkcert is used by other tools. Its CA on disk made setup go straight
	// to the password prompt without the first-run question.
	it("asks on a machine buncargo never installed on, whatever CA it has", () => {
		expect(
			setupNeedsConsent({ serviceInstalled: false, everInstalled: false }),
		).toBe(true);
	});

	it("repairs a service buncargo installed before without asking", () => {
		expect(
			setupNeedsConsent({ serviceInstalled: false, everInstalled: true }),
		).toBe(false);
		expect(
			setupNeedsConsent({ serviceInstalled: true, everInstalled: true }),
		).toBe(false);
	});
});

describe("hostsServiceFix", () => {
	it("reinstalls a stale service from a terminal", () => {
		expect(
			hostsServiceFix({
				installed: true,
				stale: REASON,
				wedged: false,
				interactive: true,
			}),
		).toEqual({
			action: "install",
			note: "Reinstalled the named-hosts service after a stale install",
		});
	});

	// Printed as a note, the stale reason read as both fixed and broken.
	it("reports a stale service it cannot reinstall without a terminal as an issue", () => {
		const fix = hostsServiceFix({
			installed: true,
			stale: REASON,
			wedged: false,
			interactive: false,
		});
		expect(fix.action).toBe("needs-terminal");
		expect(fix.action === "needs-terminal" && fix.issue).toContain(
			"needs your password: run `buncargo hosts install`",
		);
	});

	it("leaves a current, serving service alone", () => {
		expect(
			hostsServiceFix({
				installed: true,
				stale: undefined,
				wedged: false,
				interactive: false,
			}),
		).toEqual({ action: "none" });
	});
});

describe("doctorFixHosts", () => {
	useTempHome();

	// It installed and trusted for a machine that had declined, and every run
	// then ignored the result: the decline is checked before anything else.
	it("leaves a machine that declined named hosts alone", async () => {
		persistHostsDecline();
		expect(await doctorFixHosts({ interactive: false })).toEqual({
			fixed: [],
			issues: [],
		});
	});
});

describe("uninstallHosts", () => {
	// With no terminal, the `sudo cp` behind cleaning /etc/hosts fails. Thrown,
	// it stopped uninstall after the trust was gone and before the routes were
	// cleared or the decline written, so the next run set everything up again.
	it("finishes and says how to clean /etc/hosts when it cannot", async () => {
		const steps: string[] = [];
		const warnings = await uninstallHosts({
			removeService: () => steps.push("service"),
			removeTrust: () => steps.push("trust"),
			cleanHostsFile: () => {
				throw new Error("sudo: a terminal is required to read the password");
			},
			clearRoutes: async () => {
				steps.push("routes");
			},
			removeCertNames: () => steps.push("cert names"),
			persistDecline: () => steps.push("decline"),
		});
		expect(steps).toEqual([
			"service",
			"trust",
			"routes",
			"cert names",
			"decline",
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("/etc/hosts");
		expect(warnings[0]).toContain("buncargo hosts uninstall");
	});
});

describe("installHosts", () => {
	/** Every step recorded, the service already installed and current. */
	function machine(overrides: Partial<HostsInstallDeps> = {}) {
		const steps: string[] = [];
		const deps: HostsInstallDeps = {
			clearDecline: () => steps.push("clear decline"),
			ensureMkcert: async () => {
				steps.push("mkcert");
				return "/bin/mkcert";
			},
			installTrust: (mkcert) => steps.push(`trust ${mkcert}`),
			mintCertificate: async () => {
				steps.push("certificate");
			},
			serviceCurrent: () => true,
			installService: ({ force }) => {
				steps.push(`service force=${force}`);
				return {};
			},
			waitForDaemon: async () => {
				steps.push("daemon");
				return { ok: true };
			},
			...overrides,
		};
		return { steps, deps };
	}

	it("trusts and mints before it replaces the service, and passes --force through", async () => {
		// The daemon cannot bind :443 without a leaf, and will not mint one.
		const { steps, deps } = machine();
		await installHosts(deps, { reinstallService: true, force: true });
		expect(steps).toEqual([
			"clear decline",
			"mkcert",
			"trust /bin/mkcert",
			"certificate",
			"service force=true",
			"daemon",
		]);
	});

	it("leaves a current service alone unless asked to reinstall it", async () => {
		const { steps, deps } = machine();
		await installHosts(deps, {});
		expect(steps).not.toContain("service force=undefined");
		expect(steps.at(-1)).toBe("daemon");
	});

	it("returns why it kept a newer service, and fails when the daemon does not start", async () => {
		const kept = machine({
			installService: () => ({ kept: "A newer buncargo installed it" }),
		});
		expect(await installHosts(kept.deps, { reinstallService: true })).toEqual([
			"A newer buncargo installed it",
		]);

		const down = machine({
			waitForDaemon: async () => ({ ok: false, message: "port 443 is taken" }),
		});
		await expect(installHosts(down.deps, {})).rejects.toThrow(
			"port 443 is taken",
		);
	});
});
