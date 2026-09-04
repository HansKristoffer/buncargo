import {
	ensureHostsReady,
	removeHostRoutes,
	routesFromPlan,
	syncCertificateForRoutes,
	toHostsUserMessage,
	upsertHostRoutes,
	waitForDaemonRoutes,
} from "../core/hosts";
import { certificateHostnames } from "../core/hosts/plan";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";

/**
 * Claim this run's named `.localhost` routes and switch `env.urls` over to them.
 *
 * Never throws: when the daemon, certificate or registry is unavailable the run
 * continues on `http://localhost:port`.
 *
 * Returns the warnings to surface rather than printing them, because a run that
 * is about to take over another one gets a second attempt: the hostnames are
 * held by the other run until it is stopped, so a warning printed here would be
 * contradicted by the named URLs in the banner a few lines later.
 */
export async function activateNamedHosts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: { enabled: boolean },
): Promise<string[]> {
	if (!env.hosts || !options.enabled) {
		return [];
	}

	const result = await ensureHostsReady({ hosts: true });
	if (!result.ok) {
		return result.reason === "disabled"
			? []
			: [`Named URLs unavailable: ${result.message}`];
	}
	// Named hosts still work, but something about the setup will bite later.
	const notes = [...(result.notes ?? [])];

	try {
		// Widen the certificate before publishing, not after. The daemon polls
		// the registry every second, so a hostname that lands first is a
		// hostname it tries to serve with a certificate that omits it.
		await syncCertificateForRoutes({
			// Wildcards as well as this run's exact hostnames, so the next
			// worktree of this project is already covered and needs no remint —
			// and remembered under this root, so the coverage survives the
			// project not running.
			include: certificateHostnames(env.hosts.plan, env.hosts.tld),
			root: env.root,
		});
		// App routes die with this process; service routes outlive it.
		await upsertHostRoutes(
			routesFromPlan(env.hosts.plan, {
				root: env.root,
				pid: process.pid,
				kinds: ["app"],
			}),
		);
		await upsertHostRoutes(
			routesFromPlan(env.hosts.plan, {
				root: env.root,
				kinds: ["service"],
			}),
		);

		// Mint again now that this run's routes are on disk.
		//
		// The first sync read the registry before publishing, so a run that
		// minted in that gap produced a certificate covering itself and not us
		// — its mint is the one the daemon ends up serving, and our hostnames
		// fail TLS until something else remints. This second pass runs under
		// the same lock and sees every concurrent run's routes, so whichever
		// run finishes last leaves a certificate covering all of them. It
		// re-parses the certificate and mints nothing when it is already
		// sufficient, which is the normal case.
		// No `root` here: this pass exists to pick up what other runs published,
		// and this project's names were already recorded above.
		await syncCertificateForRoutes();

		// Registering a route only writes a file. Advertising the hostname before
		// the daemon has picked it up is how a banner full of https URLs ends up
		// pointing at our own 404 page, so the switch waits for the proxy to
		// confirm it is serving them.
		const serving = await waitForDaemonRoutes(
			env.hosts.plan.map((entry) => entry.hostname),
		);
		if (!serving.ok) {
			notes.push(`Named URLs unavailable: ${serving.reason}`);
			return notes;
		}

		env.setNamedHostsActive(true, { caPath: result.caPath });
	} catch (error) {
		notes.push(`Named URLs unavailable: ${toHostsUserMessage(error)}`);
	}
	return notes;
}

/**
 * Drop the app routes this process owns and revert `env.urls` to localhost.
 */
export async function releaseNamedHosts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(env: DevEnvironment<TServices, TApps>): Promise<void> {
	if (!env.hosts?.active) return;
	try {
		await removeHostRoutes(
			(route) =>
				route.root === env.root &&
				route.kind === "app" &&
				route.pid === process.pid,
		);
	} catch {
		// registry is best-effort
	}
	env.setNamedHostsActive(false);
}
