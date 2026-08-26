import { getFlagValue, hasFlag } from "./flags";

/**
 * One declarative spec per command drives argv parsing, unknown-flag detection,
 * value validation and the generated `--help` text, so those four can't drift.
 */

export interface FlagSpec {
	/** Long flag including the leading dashes, e.g. `--apps`. */
	readonly name: string;
	readonly kind: "boolean" | "string";
	readonly description: string;
	/** Rendered after the flag name in help, e.g. `=<app>`. */
	readonly valueHint?: string;
	/** Return an error message to reject the given value. */
	readonly validate?: (value: string) => string | undefined;
}

export interface CommandExample {
	readonly command: string;
	readonly description?: string;
}

export interface CommandSpec {
	readonly usage: string;
	readonly flags: readonly FlagSpec[];
	/** Help-only entries that argv parsing does not handle, e.g. `--`. */
	readonly notes?: readonly CommandExample[];
	readonly examples?: readonly CommandExample[];
}

function flagLabel(flag: FlagSpec): string {
	return `${flag.name}${flag.valueHint ?? ""}`;
}

function padRows(rows: CommandExample[]): string[] {
	const width = Math.max(...rows.map((row) => row.command.length));
	return rows.map((row) =>
		row.description
			? `  ${row.command.padEnd(width)}  ${row.description}`
			: `  ${row.command}`,
	);
}

export function formatCommandHelp(spec: CommandSpec): string {
	const optionRows: CommandExample[] = [
		...spec.flags.map((flag) => ({
			command: flagLabel(flag),
			description: flag.description,
		})),
		...(spec.notes ?? []),
	];

	const sections = [
		`Usage: ${spec.usage}`,
		"",
		"Options:",
		...padRows(optionRows),
	];

	if (spec.examples && spec.examples.length > 0) {
		sections.push("", "Examples:", ...padRows([...spec.examples]));
	}

	return `\n${sections.join("\n")}\n`;
}

/** Long flags in `args` that the spec does not declare. */
export function findUnknownFlags(spec: CommandSpec, args: string[]): string[] {
	const known = new Set(spec.flags.map((flag) => flag.name));
	return args.filter((arg) => {
		if (!arg.startsWith("--")) return false;
		return !known.has(arg.includes("=") ? (arg.split("=")[0] ?? arg) : arg);
	});
}

export function readBooleanFlag(args: string[], flag: FlagSpec): boolean {
	return hasFlag(args, flag.name);
}

/**
 * Read a string flag, appending any `validate` failure to `errors`.
 */
export function readStringFlag(
	args: string[],
	flag: FlagSpec,
	errors: string[],
): string | undefined {
	const value = getFlagValue(args, flag.name);
	if (value === undefined) return undefined;
	const problem = flag.validate?.(value);
	if (problem) {
		errors.push(problem);
		return undefined;
	}
	return value;
}

export function positiveIntegerValidator(
	label: string,
): (value: string) => string | undefined {
	return (value) => {
		const parsed = Number.parseInt(value, 10);
		if (
			!Number.isInteger(parsed) ||
			parsed <= 0 ||
			String(parsed) !== value.trim()
		) {
			return `${label} expects a positive whole number, got "${value}".`;
		}
		return undefined;
	};
}
