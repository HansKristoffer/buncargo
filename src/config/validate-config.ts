import type { AnyDevConfig, DevConfigLike } from "../types";
import { applyIntegrations } from "./integrations";
import { validateConfigShape } from "./validate-shape";
import { validateApps } from "./validation/apps";
import { createValidationContext } from "./validation/context";
import { validateReferences } from "./validation/references";
import { validateRuntimeOptions } from "./validation/runtime-options";
import { validateServices } from "./validation/services";

/**
 * Collect every problem with a dev config, in the order they were found.
 *
 * Dynamic configs cross a shape boundary before semantic checks. Typed
 * configs use the same boundary without losing their own callback signatures.
 */
export function validateConfig(value: unknown): string[] {
	let errors = validateConfigShape(value);
	if (errors.length > 0) {
		return errors;
	}

	// What integrations add is validated like everything else, so they apply
	// first; the shape they return crosses the same boundary again.
	let applied: unknown;
	try {
		applied = applyIntegrations(value as object);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
	errors = validateConfigShape(applied);
	if (errors.length > 0) {
		return errors;
	}

	const config = applied as AnyDevConfig;
	const context = createValidationContext(errors);

	if (!config.projectPrefix) {
		errors.push("projectPrefix is required");
	} else if (!/^[a-z][a-z0-9-]*$/.test(config.projectPrefix)) {
		errors.push(
			"projectPrefix must start with a letter and contain only lowercase letters, numbers, and hyphens",
		);
	}

	if (!config.services) {
		errors.push(
			"services must be an object (use {} for app-only configurations)",
		);
	}

	validateServices(config, context);
	validateRuntimeOptions(config, context);
	validateApps(config, context);
	validateReferences(config, context);

	return errors;
}

/**
 * Throw unless `config` is a valid dev config.
 *
 * Accepts `unknown` so a config imported at runtime can be validated before
 * use; for an already-typed config the assertion is a no-op, since every
 * {@link DevConfig} satisfies {@link DevConfigLike}.
 */
export function assertValidConfig(
	config: unknown,
): asserts config is DevConfigLike {
	const errors = validateConfig(config);
	if (errors.length > 0) {
		throw new Error(`Invalid dev config:\n  - ${errors.join("\n  - ")}`);
	}
}
