import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateTypecheckShape } from "../config/validation/config-shapes";
import { createShapeChecks } from "../config/validation/shape-checks";
import { CONFIG_FILES } from "../loader";
import type { TypecheckConfig } from "../types";

/**
 * The root config's `typecheck` key, for `buncargo typecheck`.
 *
 * Only the module is imported: building a dev environment would allocate
 * ports and apply integrations, none of which a typecheck needs. A config
 * that does not load is a warning, not a failure, because the config's own
 * typecheck reports what is wrong with it; an invalid `typecheck` key is an
 * error, because the entries it names would otherwise go unchecked.
 */
export async function loadTypecheckConfig(root: string): Promise<{
	config?: TypecheckConfig;
	warning?: string;
	errors: string[];
}> {
	const file = CONFIG_FILES.find((name) => existsSync(join(root, name)));
	if (!file) return { errors: [] };

	let value: unknown;
	try {
		const mod = (await import(join(root, file))) as { default?: unknown };
		value = (mod.default as { typecheck?: unknown } | undefined)?.typecheck;
	} catch (error) {
		return {
			warning: `Could not load ${file}, so its typecheck settings are not applied: ${error instanceof Error ? error.message : String(error)}`,
			errors: [],
		};
	}

	const errors: string[] = [];
	validateTypecheckShape(value, createShapeChecks(errors));
	if (errors.length > 0) return { errors };
	return { config: value as TypecheckConfig | undefined, errors: [] };
}
