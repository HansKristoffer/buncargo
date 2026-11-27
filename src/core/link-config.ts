import type { ProfileLinkOverride, ResolvedLinkConfig } from "../types";

/**
 * Pure profile link-override composition, kept separate from `links.ts` so
 * pure config resolution (`config/resolve.ts`, `getEnvVar`) never imports the
 * run registry or file locking.
 */

/**
 * Apply an active profile's `links` overrides to the config's `links`.
 * A `false` override keeps the entry with `disabled: true` so inspection
 * (`buncargo links`, `status`) shows why it is inactive.
 */
export function applyProfileLinkOverrides(
	links: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
	overrides:
		Readonly<Record<string, ProfileLinkOverride | undefined>> | undefined,
): Readonly<Record<string, ResolvedLinkConfig>> | undefined {
	if (!links) return undefined;
	if (!overrides || Object.keys(overrides).length === 0) return links;

	const result: Record<string, ResolvedLinkConfig> = {};
	for (const [name, spec] of Object.entries(links)) {
		const override = overrides[name];
		if (override === undefined) {
			result[name] = spec;
		} else if (override === false) {
			result[name] = { ...spec, disabled: true };
		} else {
			result[name] = {
				...spec,
				disabled: false,
				...(override.required !== undefined
					? { required: override.required }
					: {}),
				...(override.apps !== undefined ? { apps: override.apps } : {}),
				...(override.services !== undefined
					? { services: override.services }
					: {}),
				...(override.onChange !== undefined
					? { onChange: override.onChange }
					: {}),
				...(override.profile !== undefined
					? { profile: override.profile }
					: {}),
			};
		}
	}
	return result;
}
