import { join } from "node:path";
import {
	validateCheckShape,
	validatePredeployShape,
	validateTypecheckShape,
} from "../config/validation/config-shapes";
import {
	createShapeChecks,
	type ShapeChecks,
} from "../config/validation/shape-checks";
import { findRootConfigFile } from "../loader/find-config-file";
import type { CheckConfig, TypecheckConfig } from "../types";

export interface RootConfigKey<T> {
	config?: T;
	/** Set when the config would not load; the key's defaults apply. */
	warning?: string;
	errors: string[];
}

/**
 * One key of the root config, for a command that needs no dev environment
 * (`typecheck`, `check`, `predeploy`).
 *
 * Only the module is imported: building a dev environment would allocate
 * ports and apply integrations, none of which these commands need. A config
 * that does not load is a warning, not a failure, because the config's own
 * typecheck reports what is wrong with it; an invalid key is an error,
 * because what it names would otherwise go unchecked.
 */
async function loadRootConfigKey<T>(
	root: string,
	key: string,
	validate: (value: unknown, checks: ShapeChecks) => void,
	whole = false,
): Promise<RootConfigKey<T>> {
	const file = findRootConfigFile(root);
	if (!file) return { errors: [] };

	let config: Record<string, unknown> | undefined;
	try {
		const mod = (await import(join(root, file))) as { default?: unknown };
		config = mod.default as Record<string, unknown> | undefined;
	} catch (error) {
		return {
			warning: `Could not load ${file}, so its ${key} settings are not applied: ${error instanceof Error ? error.message : String(error)}`,
			errors: [],
		};
	}

	const errors: string[] = [];
	const value = config?.[key];
	validate(value, createShapeChecks(errors));
	if (errors.length > 0) return { errors };
	return { config: (whole ? config : value) as T | undefined, errors: [] };
}

/** The root config's `typecheck` key, for `buncargo typecheck`. */
export function loadTypecheckConfig(root: string) {
	return loadRootConfigKey<TypecheckConfig>(
		root,
		"typecheck",
		validateTypecheckShape,
	);
}

/** The root config's `check` key, for `buncargo check`. */
export function loadCheckConfig(root: string) {
	return loadRootConfigKey<CheckConfig>(root, "check", validateCheckShape);
}

/**
 * The whole root config, with its `predeploy` key validated: `buncargo
 * predeploy` also reads `prisma`, `migrations` and `seed`.
 */
export function loadPredeployConfig(root: string) {
	return loadRootConfigKey<Record<string, unknown>>(
		root,
		"predeploy",
		validatePredeployShape,
		true,
	);
}
