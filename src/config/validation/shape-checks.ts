export function createShapeChecks(errors: string[]) {
	const object = (input: unknown): input is Record<string, unknown> =>
		typeof input === "object" && input !== null && !Array.isArray(input);
	const record = (
		input: unknown,
		path: string,
	): input is Record<string, unknown> => {
		if (object(input)) return true;
		errors.push(`${path} must be an object`);
		return false;
	};
	const check = (
		input: unknown,
		path: string,
		valid: boolean,
		expected: string,
	) => {
		if (input !== undefined && !valid)
			errors.push(`${path} must be ${expected}`);
	};
	const strings = (input: unknown): input is string[] =>
		Array.isArray(input) &&
		input.every((entry) => typeof entry === "string" && entry.length > 0);
	const fields = (
		input: Record<string, unknown>,
		path: string,
		keys: string[],
		type: string,
	) => {
		for (const key of keys)
			check(
				input[key],
				`${path}${key}`,
				typeof input[key] === type,
				`a ${type}`,
			);
	};
	const duration = (input: unknown, path: string) =>
		check(
			input,
			path,
			typeof input === "number" && Number.isFinite(input) && input > 0,
			"a finite positive duration in milliseconds",
		);
	const envValues = (input: unknown, path: string) => {
		if (input === undefined || !record(input, path)) return;
		for (const [name, item] of Object.entries(input))
			check(
				item,
				`${path}.${name}`,
				typeof item === "string" ||
					(typeof item === "number" && Number.isFinite(item)),
				"a string or finite number",
			);
	};
	return {
		errors,
		object,
		record,
		check,
		strings,
		fields,
		duration,
		envValues,
	};
}
export type ShapeChecks = ReturnType<typeof createShapeChecks>;

export const SECRETS_FIELDS = [
	"projectId",
	"organizationId",
	"environment",
	"siteUrl",
	"path",
];
