import { describe, expect, it } from "bun:test";
import { validateCheckShape, validateTypecheckShape } from "./config-shapes";
import { createShapeChecks } from "./shape-checks";

function errorsOf(
	validate: typeof validateCheckShape,
	value: unknown,
): string[] {
	const errors: string[] = [];
	validate(value, createShapeChecks(errors));
	return errors;
}

describe("check steps in the config", () => {
	it("accepts testAlso, testDeferred, a gate fix and rootWide", () => {
		expect(
			errorsOf(validateCheckShape, {
				testAlso: [{ when: ["src/api/**"], tests: ["test/api.test.ts"] }],
				testDeferred: {
					files: ["**/*.database.test.ts"],
					command: "bunx buncargo ci -- bun test",
					strict: true,
				},
				gates: [
					{
						name: "codegen",
						command: "x",
						fix: "bun run gen",
						rootWide: false,
					},
				],
			}),
		).toEqual([]);
	});

	it("rejects a gate that shadows a built-in step or an earlier gate", () => {
		expect(
			errorsOf(validateCheckShape, {
				gates: [
					{ name: "tests", command: "x" },
					{ name: "codegen", command: "x" },
					{ name: "codegen", command: "y" },
				],
			}),
		).toEqual([
			'check.gates.0.name: "tests" is a built-in check step; name the gate something else',
			'check.gates.2.name: "codegen" is used by an earlier gate',
		]);
	});

	it("requires the globs of testAlso and testDeferred", () => {
		expect(
			errorsOf(validateCheckShape, {
				testAlso: [{ when: ["src/**"] }],
				testDeferred: { strict: "yes" },
			}),
		).toEqual([
			"check.testAlso.0.tests must be an array of globs",
			"check.testDeferred.files must be an array of globs",
			"check.testDeferred.strict must be a boolean",
		]);
	});
});

it("requires typecheck.scripts to name at least one script", () => {
	expect(errorsOf(validateTypecheckShape, { scripts: [] })).toEqual([
		"typecheck.scripts must be a nonempty array of script names",
	]);
	expect(
		errorsOf(validateTypecheckShape, {
			scripts: ["typecheck", "typecheck:e2e"],
		}),
	).toEqual([]);
});
