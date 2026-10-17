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
import {
	activateTailscaleServe,
	releaseTailscaleServe,
	tailscaleServeDeps,
} from "../core/hosts/tailscale-serve";
import type {
	AppConfig,
	DevEnvironment,
	HostsRuntime,
	ServiceConfig,
} from "../types";

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
): Promise<string[]> {
	if (!env.hosts || !options.enabled) {
		return [];
	}
	if (env.hosts.mode === "tailscale")
		return activateTailscaleHosts(env, env.hosts, options);

	// Named hosts still work, but something about the setup will bite later.
	const notes: string[] = [];
	// A retry that fails must not leave the first attempt's named URLs in
	// `env.urls`, or the banner prints them beside this warning.
	const unavailable = (reason: string): string[] => {
		env.setNamedHostsActive(false);
		return [...notes, `Named URLs unavailable: ${reason}`];
	};

	options.signal?.throwIfAborted();
	const result = await ensureHostsReady({ hosts: true });
	options.signal?.throwIfAborted();
	if (!result.ok) {
		return result.reason === "disabled" ? [] : unavailable(result.message);
	}
	notes.push(...(result.notes ?? []));

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
		options.signal?.throwIfAborted();
		await upsertHostRoutes(
			routesFromPlan(env.hosts.plan, {
				root: env.root,
				pid: process.pid,
				kinds: ["app"],
			}),
			{ takeover: new Set(options.takeover) },
		);
		options.signal?.throwIfAborted();
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
		options.signal?.throwIfAborted();
		await syncCertificateForRoutes();
		options.signal?.throwIfAborted();

		// Registering a route only writes a file. Advertising the hostname before
		// the daemon has picked it up is how a banner full of https URLs ends up
		// pointing at our own 404 page, so the switch waits for the proxy to
		// confirm it is serving them.
		const serving = await waitForDaemonRoutes(
			env.hosts.plan.map((entry) => entry.hostname),
		);
		if (!serving.ok) return unavailable(serving.reason);

		options.signal?.throwIfAborted();
		env.setNamedHostsActive(true, { caPath: result.caPath });
	} catch (error) {
		options.signal?.throwIfAborted();
		return unavailable(toHostsUserMessage(error));
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
 * file write, no fork. Best-effort, like the rest of the registry.
 */
export async function reclaimAppRoute(
	env: { root: string; hosts: HostsRuntime | null },
	name: string,
): Promise<void> {
	if (!env.hosts?.active) return;
	if (env.hosts.mode === "tailscale") {
		await reclaimTailscaleApp(env.root, env.hosts, name);
		return;
	}
	const routes = routesFromPlan(env.hosts.plan, {
		root: env.root,
		pid: process.pid,
		kinds: ["app"],
	}).filter((route) => route.name === name);
	if (routes.length === 0) return;
	try {
		await upsertHostRoutes(routes);
	} catch {
		// A conflict is another project's hostname: activation already said so.
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
