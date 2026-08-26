import {
	ensureHostsReady,
	removeHostRoutes,
	routesFromPlan,
	syncCertificateForRoutes,
	toHostsUserMessage,
	upsertHostRoutes,
} from "../core/hosts";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import * as log from "./log";

/**
 * Claim this run's named `.localhost` routes and switch `env.urls` over to them.
 *
 * Never throws: when the daemon, certificate or registry is unavailable the run
 * continues on `http://localhost:port`.
 */
export async function activateNamedHosts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: { enabled: boolean },
): Promise<void> {
	if (!env.hosts || !options.enabled) {
		return;
	}

	const result = await ensureHostsReady({ hosts: true });
	if (!result.ok) {
		if (result.reason !== "disabled") {
			log.warn(`Named URLs unavailable: ${result.message}`);
		}
		return;
	}
	// Named hosts still work, but something about the setup will bite later.
	for (const note of result.notes ?? []) {
		log.warn(note);
	}

	try {
		// Widen the certificate before publishing, not after. The daemon polls
		// the registry every second, so a hostname that lands first is a
		// hostname it tries to serve with a certificate that omits it.
		await syncCertificateForRoutes({
			include: env.hosts.plan.map((entry) => entry.hostname),
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
		env.setNamedHostsActive(true, { caPath: result.caPath });
	} catch (error) {
		log.warn(`Named URLs unavailable: ${toHostsUserMessage(error)}`);
	}
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
