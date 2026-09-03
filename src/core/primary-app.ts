import type { AppConfig, HostsOptionsLike } from "../types";

/**
 * Which app is "the app" for this project.
 *
 * Four things wanted this answer independently — the bare named hostname
 * (`options.hosts.primaryApp`), `getFrontendPort` (`options.frontendApp`,
 * falling back to `platform` then `web`), `getExpoApiUrl` (`options.expoApiApp`)
 * and now the menu bar's Open button — and each shipped its own default. A
 * project could therefore have a different "main" app depending on which
 * surface you looked at.
 *
 * One resolver, one order:
 *
 * 1. `options.primaryApp`, the knob that exists to be explicit.
 * 2. `options.hosts.primaryApp`, because a project that gave one app the bare
 *    hostname has already answered this question.
 * 3. `options.frontendApp`, the older spelling of the same intent.
 * 4. The dependency root: the one selected app that no other selected app lists
 *    in `requiredApps`. In an API + web project that is the web app, which is
 *    what someone clicking "open" wants.
 * 5. The first selected app, so this never returns nothing when apps exist.
 *
 * Steps 4 and 5 look only at `selected`, not at every configured app: a
 * `--apps=api` run's primary app is `api`, whatever the config would say for a
 * full run.
 */
export interface PrimaryAppInput {
	apps: Record<string, AppConfig>;
	options?: {
		primaryApp?: string;
		frontendApp?: string;
		hosts?: boolean | HostsOptionsLike;
	};
	/** App keys this run actually started. Defaults to every configured app. */
	selected?: readonly string[];
}

/**
 * Only what the config says, with no inference.
 *
 * Named hostnames read this rather than {@link resolvePrimaryApp}: the bare
 * `myapp.localhost` is a name other people have bookmarked and pasted into
 * OAuth callback lists, so inferring a new owner for it from the dependency
 * graph would silently move it on an upgrade.
 */
export function configuredPrimaryApp(
	options: PrimaryAppInput["options"],
): string | undefined {
	if (options?.primaryApp) return options.primaryApp;
	const hosts = options?.hosts;
	if (typeof hosts === "object" && hosts.primaryApp) return hosts.primaryApp;
	return options?.frontendApp;
}

/**
 * Apps nothing else in the set depends on.
 *
 * `requiredApps` points from dependent to dependency, so the roots are the keys
 * that never appear on the right-hand side.
 */
function dependencyRoots(
	apps: Record<string, AppConfig>,
	names: readonly string[],
): string[] {
	const inSet = new Set(names);
	const depended = new Set<string>();
	for (const name of names) {
		for (const required of apps[name]?.requiredApps ?? []) {
			if (inSet.has(required)) depended.add(required);
		}
	}
	return names.filter((name) => !depended.has(name));
}

export function resolvePrimaryApp(input: PrimaryAppInput): string | undefined {
	const names = input.selected ?? Object.keys(input.apps);
	if (names.length === 0) return undefined;

	// Only honored when it is in the running set: pointing "open" at an app this
	// run did not start is worse than falling through to one it did.
	const configured = configuredPrimaryApp(input.options);
	if (configured && names.includes(configured)) return configured;

	const roots = dependencyRoots(input.apps, names);
	return roots[0] ?? names[0];
}
