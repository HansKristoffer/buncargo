/**
 * Filesystem reader for `<root>/.infisical.json`, kept separate from pure
 * `scope.ts` so `buncargo` config helpers stay free of `node:fs` I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, mapValues } from "hanzio";
import type { SecretsScopeInput } from "../../types";
import { isScopeList, primaryScope } from "./scope";

/** Read `workspaceId` from `<root>/.infisical.json`, or `undefined` if absent/invalid. */
export function readInfisicalProjectId(root: string): string | undefined {
	const configPath = join(root, ".infisical.json");
	if (!existsSync(configPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		if (!isRecord(parsed)) return undefined;
		const workspaceId = parsed.workspaceId;
		return typeof workspaceId === "string" && workspaceId.trim() !== ""
			? workspaceId.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

function fillScopeProjectId(
	input: SecretsScopeInput | false | undefined,
	projectId: string,
): SecretsScopeInput | false | undefined {
	if (!input) return input;
	if (isScopeList(input)) {
		const [first, ...rest] = input;
		if (!first || first.projectId) return input;
		return [{ ...first, projectId }, ...rest];
	}
	return input.projectId ? input : { ...input, projectId };
}

/**
 * Fill omitted `projectId` fields from `<root>/.infisical.json`'s `workspaceId`
 * on declared `secrets` scopes without opting in configs or apps that never
 * declared `secrets`. When top-level `secrets` is `false`, profiles that
 * explicitly re-enable `secrets` still inherit `workspaceId`.
 */
export function applyInfisicalProjectConfig<
	T extends {
		secrets?: SecretsScopeInput | false;
		apps?: Record<string, { secrets?: SecretsScopeInput | false }>;
		seed?: { secrets?: SecretsScopeInput | false };
		migrations?: { secrets?: SecretsScopeInput | false }[];
		profiles?: Record<string, { secrets?: SecretsScopeInput | false }>;
	},
>(config: T, root: string): T {
	const projectId = readInfisicalProjectId(root);
	if (!projectId) return config;

	const topDisabled = config.secrets === false;
	const defaultProjectId = primaryScope(config.secrets)?.projectId;
	const nextSecrets =
		!topDisabled && config.secrets !== undefined
			? fillScopeProjectId(config.secrets, projectId)
			: undefined;
	const effectiveDefaultProjectId =
		defaultProjectId ?? (nextSecrets ? projectId : undefined);

	const nextApps =
		!topDisabled && config.apps
			? mapValues(config.apps, (app) =>
					app.secrets && !effectiveDefaultProjectId
						? { ...app, secrets: fillScopeProjectId(app.secrets, projectId) }
						: app,
				)
			: undefined;
	const nextSeed =
		!topDisabled && config.seed?.secrets && !effectiveDefaultProjectId
			? {
					...config.seed,
					secrets: fillScopeProjectId(config.seed.secrets, projectId),
				}
			: config.seed;
	const nextMigrations = !topDisabled
		? config.migrations?.map((migration) =>
				migration.secrets && !effectiveDefaultProjectId
					? {
							...migration,
							secrets: fillScopeProjectId(migration.secrets, projectId),
						}
					: migration,
			)
		: undefined;
	const nextProfiles = config.profiles
		? mapValues(config.profiles, (profile) =>
				profile.secrets && (!effectiveDefaultProjectId || topDisabled)
					? {
							...profile,
							secrets: fillScopeProjectId(profile.secrets, projectId),
						}
					: profile,
			)
		: undefined;

	return {
		...config,
		...(nextSecrets !== undefined ? { secrets: nextSecrets } : {}),
		...(nextApps !== undefined ? { apps: nextApps } : {}),
		...(nextSeed !== undefined ? { seed: nextSeed } : {}),
		...(nextMigrations !== undefined ? { migrations: nextMigrations } : {}),
		...(nextProfiles !== undefined ? { profiles: nextProfiles } : {}),
	};
}
