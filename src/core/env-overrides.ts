/**
 * Per-checkout environment overrides: `.buncargo/env.json`, written by
 * `buncargo env set` and applied to every run, `exec`, task and
 * `env --export` of this checkout.
 *
 * For a value a shared file gets wrong for one checkout (a `.env.local`
 * synced from another worktree that points at its ports). Prefixing every
 * `buncargo dev` with the variable worked until the one restart without it.
 * Above `options.envFiles` and buncargo's own values, below the shell: a
 * variable set on the command line still wins for that command.
 */

import { withFileLock } from "./file-lock";
import { readJsonDocumentSync, writeJsonDocument } from "./registry-file";
import { projectStateFilePath } from "./state-paths";
import { formatWarn } from "./style";

export function getEnvOverridesPath(root: string): string {
	return projectStateFilePath(root, "env.json");
}

function validate(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const values = (value as { values?: unknown }).values;
	if (typeof values !== "object" || values === null) return undefined;
	return Object.fromEntries(
		Object.entries(values).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

export function readEnvOverrides(root: string): Record<string, string> {
	return readJsonDocumentSync(getEnvOverridesPath(root), validate) ?? {};
}

/** A shell variable name, as `env set` accepts it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `KEY=VALUE` as typed; the value may be empty or contain `=`. */
export function parseEnvAssignment(
	text: string,
): { key: string; value: string } | { error: string } {
	const at = text.indexOf("=");
	const key = at === -1 ? text : text.slice(0, at);
	if (at === -1) return { error: `Expected KEY=VALUE, got "${text}".` };
	if (!ENV_NAME.test(key)) return { error: `"${key}" is not a variable name.` };
	return { key, value: text.slice(at + 1) };
}

/** Apply `set` then `unset` under the file's lock; returns the overrides now stored. */
export async function updateEnvOverrides(
	root: string,
	change: { set?: Record<string, string>; unset?: readonly string[] },
): Promise<Record<string, string>> {
	const path = getEnvOverridesPath(root);
	return withFileLock(path, async () => {
		const values = { ...readEnvOverrides(root), ...change.set };
		for (const key of change.unset ?? []) delete values[key];
		const sorted = Object.fromEntries(
			Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
		);
		await writeJsonDocument(path, { version: 1, values: sorted });
		return sorted;
	});
}

/**
 * Put each override on top of a computed environment. `input` is the
 * environment input, where the shell already outranks the override.
 */
export function applyEnvOverrides(
	vars: Record<string, string>,
	overrides: Readonly<Record<string, string>>,
	input: Readonly<Record<string, string>>,
): void {
	for (const [key, value] of Object.entries(overrides))
		vars[key] = input[key] ?? value;
}

/** Overridden secret keys already warned about in this process. */
const warnedShadows = new Set<string>();

/**
 * Say once per key that an override hides an Infisical secret: the override
 * wins, and nothing else would tell that the secret is not what runs.
 */
export function warnShadowedSecrets(
	root: string,
	overrides: Readonly<Record<string, string>>,
	secretKeys: Iterable<string>,
): void {
	const shadowed = [...new Set(secretKeys)].filter(
		(key) => key in overrides && !warnedShadows.has(key),
	);
	if (shadowed.length === 0) return;
	for (const key of shadowed) warnedShadows.add(key);
	const keys = shadowed.join(", ");
	console.warn(
		formatWarn(
			`buncargo env set overrides the Infisical secret ${keys} in ${root}. \`buncargo env unset ${shadowed.join(" ")}\` uses the secret again.`,
		),
	);
}
