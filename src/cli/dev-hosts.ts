import {
	ensureHostsReady,
	identityRouteOwners,
	machineMkcert,
	removeHostRoutes,
	routesFromPlan,
	syncCertificateForRoutes,
	toHostsUserMessage,
	upsertHostRoutes,
	waitForDaemonRoutes,
	withdrawHostRoutes,
} from "../core/hosts";
import type { DaemonRouteCheck } from "../core/hosts/daemon-client";
import type { HostsEnableResult } from "../core/hosts/onboarding";
import { certificateHostnames } from "../core/hosts/plan";
import type { RouteOwners } from "../core/hosts/registry";
import {
	activateTailscaleServe,
	releaseTailscaleServe,
	tailscaleServeDeps,
} from "../core/hosts/tailscale-serve";
import { readCurrentProcessIdentityAsync } from "../core/process-identity";
import type {
	AppConfig,
	DevEnvironment,
	HostsRuntime,
	ServiceConfig,
} from "../types";

const HOSTS_FALLBACK = "Named URLs unavailable:";

/** The machine edges of {@link activateNamedHosts}: the daemon, certificate and owners. */
export interface NamedHostsDeps {
	ensureHostsReady: () => Promise<HostsEnableResult>;
	syncCertificateForRoutes: (options?: {
		include?: string[];
		root?: string;
	}) => Promise<unknown>;
	waitForDaemonRoutes: (hostnames: string[]) => Promise<DaemonRouteCheck>;
	owners: RouteOwners;
}

export const machineNamedHostsDeps: NamedHostsDeps = {
	ensureHostsReady: () => ensureHostsReady({ hosts: true }),
	syncCertificateForRoutes: (options) =>
		syncCertificateForRoutes(machineMkcert, options),
	waitForDaemonRoutes,
	owners: identityRouteOwners,
};

/**
 * Claim this run's named `.localhost` routes and switch `env.urls` over to them.
 *
 * Never throws: when the daemon, certificate or registry is unavailable the run
 * continues on `http://localhost:port`.
 *
 * Returns the warnings to surface rather than printing them, because a run that
 * goes on to take over another one activates a second time, and only the last
 * attempt describes the URLs the banner prints.
 *
 * `takeover` names the apps this run has just taken from another run of the
 * same checkout. Their routes change owner, so that run's exit cannot delete
 * them.
 */
export async function activateNamedHosts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: {
		enabled: boolean;
		signal?: AbortSignal;
		takeover?: readonly string[];
	},
	deps: NamedHostsDeps,
): Promise<string[]> {
	if (!env.hosts) {
		return [];
	}
	const { hosts } = env;
	if (hosts.mode === "tailscale")
		return options.enabled ? activateTailscaleHosts(env, hosts, options) : [];

	// Named hosts still work, but something about the setup will bite later.
	const notes: string[] = [];
	// Every way out on `localhost:port` withdraws what this checkout has
	// registered: this attempt's routes, and service routes an earlier run
	// left, unless another live run of the checkout holds them. Left there,
	// `env` and `getEnvVar` read them as this checkout's named URLs being
	// live. A retry that fails must also not leave the first attempt's named
	// URLs in `env.urls`, or the banner prints them beside this warning.
	const fallBack = async (reason?: string): Promise<string[]> => {
		try {
			await withdrawHostRoutes({ root: env.root, pid: process.pid });
		} catch {
			// An unreadable registry: activation reports it, or had nothing to.
		}
		env.setNamedHostsActive(false);
		return reason === undefined
			? notes
			: [...notes, `${HOSTS_FALLBACK} ${reason}`];
	};

	if (!options.enabled) return fallBack();
	options.signal?.throwIfAborted();
	const result = await deps.ensureHostsReady();
	options.signal?.throwIfAborted();
	if (!result.ok) {
		return fallBack(result.reason === "disabled" ? undefined : result.message);
	}
	notes.push(...(result.notes ?? []));

	try {
		// Widen the certificate before publishing, not after. The daemon polls
		// the registry every second, so a hostname that lands first is a
		// hostname it tries to serve with a certificate that omits it.
		await deps.syncCertificateForRoutes({
			// Wildcards as well as this run's exact hostnames, so the next
			// worktree of this project is already covered and needs no remint —
			// and remembered under this root, so the coverage survives the
			// project not running.
			include: certificateHostnames(hosts.plan, hosts.tld),
			root: env.root,
		});
		// App routes die with this process; service routes outlive it. A
		// hostname a live owner elsewhere holds stays on `localhost:port`
		// alone, with a warning naming that owner.
		options.signal?.throwIfAborted();
		const conflicts = await upsertHostRoutes(
			[
				...routesFromPlan(hosts.plan, {
					root: env.root,
					pid: process.pid,
					processIdentity: await readCurrentProcessIdentityAsync(),
					kinds: ["app"],
				}),
				...routesFromPlan(hosts.plan, { root: env.root, kinds: ["service"] }),
			],
			{ takeover: new Set(options.takeover), owners: deps.owners },
		);
		const held = new Set(conflicts.map((conflict) => conflict.hostname));
		notes.push(
			...conflicts.map((conflict) => `${HOSTS_FALLBACK} ${conflict.message}`),
		);
		const hostnames = hosts.plan
			.map((entry) => entry.hostname)
			.filter((hostname) => !held.has(hostname));
		if (hostnames.length === 0) return fallBack();

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
		options.signal?.throwIfAborted();
		await deps.syncCertificateForRoutes();
		options.signal?.throwIfAborted();

		// Registering a route only writes a file. Advertising the hostname before
		// the daemon has picked it up is how a banner full of https URLs ends up
		// pointing at our own 404 page, so the switch waits for the proxy to
		// confirm it is serving them.
		const serving = await deps.waitForDaemonRoutes(hostnames);
		if (!serving.ok) return fallBack(serving.reason);

		options.signal?.throwIfAborted();
		env.setNamedHostsActive(true, {
			caPath: result.caPath,
			...(held.size === 0 ? {} : { hostnames }),
		});
	} catch (error) {
		options.signal?.throwIfAborted();
		return fallBack(toHostsUserMessage(error));
	}
	return notes;
}

/**
 * `BUNCARGO_HOSTS=tailscale`: serve each app on its own HTTPS port of the
 * machine's Tailscale name, and switch `env.urls` to the apps Tailscale
 * answers for. An app it does not answer for keeps its plain URL, with a
 * `Named URLs unavailable:` warning, which `dev --detach` repeats.
 */
async function activateTailscaleHosts(
	env: {
		root: string;
		ports: object;
		setNamedHostsActive: DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>["setNamedHostsActive"];
	},
	hosts: HostsRuntime,
	options: { signal?: AbortSignal; takeover?: readonly string[] },
): Promise<string[]> {
	const unavailable = (reason: string) => `Named URLs unavailable: ${reason}`;
	options.signal?.throwIfAborted();
	const apps = hosts.plan
		.filter((entry) => entry.kind === "app")
		.map((entry) => ({ name: entry.name, port: entry.targetPort }));
	try {
		const result = await activateTailscaleServe(
			{
				root: env.root,
				pid: process.pid,
				processIdentity: await readCurrentProcessIdentityAsync(),
				apps,
				blockPorts: Object.values(env.ports as Record<string, number>),
				takeover: new Set(options.takeover),
			},
			tailscaleServeDeps(),
		);
		options.signal?.throwIfAborted();
		env.setNamedHostsActive(Object.keys(result.urls).length > 0, {
			tailscaleUrls: result.urls,
		});
		return [...result.notes, ...result.fallbacks.map(unavailable)];
	} catch (error) {
		// The record's lock or file, never Tailscale itself: that degrades
		// inside. The run goes on with its plain URLs either way.
		options.signal?.throwIfAborted();
		env.setNamedHostsActive(false);
		return [unavailable(toHostsUserMessage(error))];
	}
}

/**
 * Claim one app's route again when it restarts in a run serving named hosts.
 *
 * A run that took this app over moved its route to itself, and that run's
 * exit deleted it; restarted here, the app would serve a named URL that 404s.
 * A route another live run of this checkout holds stays that run's. One locked
 * file write, no fork.
 *
 * Returns why the route could not be claimed, for the app's output: the
 * restart goes ahead on its named URL either way, and a silent failure here
 * is a URL that 404s with nothing saying why.
 */
export async function reclaimAppRoute(
	env: { root: string; hosts: HostsRuntime | null },
	name: string,
): Promise<string | undefined> {
	if (!env.hosts?.active) return undefined;
	if (env.hosts.mode === "tailscale") {
		await reclaimTailscaleApp(env.root, env.hosts, name);
		return undefined;
	}
	const routes = routesFromPlan(env.hosts.plan, {
		root: env.root,
		pid: process.pid,
		processIdentity: await readCurrentProcessIdentityAsync(),
		kinds: ["app"],
	}).filter((route) => route.name === name);
	if (routes.length === 0) return undefined;
	try {
		const [conflict] = await upsertHostRoutes(routes, {
			owners: identityRouteOwners,
		});
		return conflict && `${HOSTS_FALLBACK} ${conflict.message}`;
	} catch (error) {
		return `${HOSTS_FALLBACK} ${toHostsUserMessage(error)}`;
	}
}

/**
 * The Tailscale side of {@link reclaimAppRoute}: an entry another run took
 * over and then removed is added back. One that a live run of this checkout
 * holds stays that run's; an intact one costs two reads and a probe.
 */
async function reclaimTailscaleApp(
	root: string,
	hosts: HostsRuntime,
	name: string,
): Promise<void> {
	const app = hosts.plan.find(
		(entry) => entry.kind === "app" && entry.name === name,
	);
	if (!app || !hosts.tailscaleUrls[name]) return;
	try {
		await activateTailscaleServe(
			{
				root,
				pid: process.pid,
				processIdentity: await readCurrentProcessIdentityAsync(),
				apps: [{ name, port: app.targetPort }],
				blockPorts: [],
				takeover: new Set(),
			},
			tailscaleServeDeps(),
		);
	} catch {
		// Best-effort, like the route: activation already reported the setup.
	}
}

/**
 * Drop the app routes this process owns and revert `env.urls` to localhost.
 */
export async function releaseNamedHosts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(env: DevEnvironment<TServices, TApps>): Promise<string[]> {
	if (!env.hosts) return [];
	if (env.hosts.mode === "tailscale") {
		const warnings = await releaseTailscaleServe(
			{ root: env.root, pid: process.pid },
			tailscaleServeDeps(),
		);
		env.setNamedHostsActive(false);
		return warnings;
	}
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
	return [];
}
