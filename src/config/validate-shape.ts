import { validateSupplementShapes } from "./validation/config-shapes";
import { validateEntryShapes } from "./validation/entry-shapes";
import { createShapeChecks } from "./validation/shape-checks";

/** Validate imported config shapes before any semantic check dereferences them. */
export function validateConfigShape(value: unknown): string[] {
	const errors: string[] = [];
	const checks = createShapeChecks(errors);
	if (!checks.record(value, "config")) return errors;
	checks.fields(value, "", ["projectPrefix"], "string");
	checks.fields(value, "", ["env"], "function");
	validateEntryShapes(value, checks);
	validateSupplementShapes(value, checks);
	return errors;
}
