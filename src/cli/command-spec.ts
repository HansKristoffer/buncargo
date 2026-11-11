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

function flagName(arg: string): string {
	const equals = arg.indexOf("=");
	return equals === -1 ? arg : arg.slice(0, equals);
}

/**
 * Long flags in `args` that the spec does not declare, and boolean flags
 * given a value (`--detach=1`): none takes one, and reading such a flag as
 * set while it does not match the flag let `dev --detach=1` re-detach forever.
 */
export function findUnknownFlags(spec: CommandSpec, args: string[]): string[] {
	return args.filter((arg) => {
		if (!arg.startsWith("--")) return false;
		const flag = spec.flags.find((entry) => entry.name === flagName(arg));
		if (!flag) return true;
		return flag.kind === "boolean" && arg !== flag.name;
	});
}

/** The error for one of {@link findUnknownFlags}' results. */
export function unknownFlagMessage(spec: CommandSpec, arg: string): string {
	const name = flagName(arg);
	const takesNoValue = spec.flags.some(
		(flag) => flag.name === name && flag.kind === "boolean",
	);
	return takesNoValue
		? `${name} takes no value: pass ${name}, not ${arg}.`
		: `Unknown flag: ${arg}`;
}

/**
 * Whether the flag was given. A boolean flag counts only as written, a string
 * flag also with its value (`--expose=api`).
 */
export function readBooleanFlag(args: string[], flag: FlagSpec): boolean {
	return flag.kind === "boolean"
		? args.includes(flag.name)
		: hasFlag(args, flag.name);
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

export function enumValidator(
	label: string,
	allowed: readonly string[],
): (value: string) => string | undefined {
	return (value) =>
		allowed.includes(value)
			? undefined
			: `${label} expects one of ${allowed.join(", ")}, got "${value}".`;
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

/**
 * Arguments that are not `--` flags, skipping the value of a spec'd string
 * flag written as `--flag value` (taken the way `getFlagValue` takes it), so
 * it is not mistaken for a subcommand. A single-dash token is positional:
 * no command declares short flags, so it is reported rather than ignored.
 */
export function readPositionals(spec: CommandSpec, args: string[]): string[] {
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const flag = spec.flags.find((entry) => entry.name === arg);
		if (flag?.kind === "string" && !(args[index + 1] ?? "-").startsWith("-")) {
			index++;
		}
	}
	return positionals;
}
