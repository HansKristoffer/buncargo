import { parseArgs as parseTokens } from "node:util";
import { ArgumentsError, argumentsError } from "./errors";
import * as log from "./log";

/**
 * One definition per command: its spec parses argv, renders `--help` and the
 * root help row, and its exit codes feed `help agents exits`, so none of them
 * can drift from what the command accepts.
 */

export interface FlagSpec {
	/**
	 * `boolean` takes no value; `string` requires one (`--profile=full` or
	 * `--profile full`); `optional` is `--expose` alone or `--expose=api`, never
	 * `--expose api`.
	 */
	readonly kind: "boolean" | "string" | "optional";
	readonly description: string;
	/** A one-letter alias, e.g. `f` for `-f`. */
	readonly short?: string;
	/** The value's name in help, e.g. `<app>`. */
	readonly value?: string;
	/** Return an error message to reject the given value. */
	readonly validate?: (value: string) => string | undefined;
}

export interface ArgSpec {
	/** As help shows it, e.g. `<app>`. */
	readonly name: string;
	readonly description: string;
	readonly required?: true;
	/** Takes every remaining positional; only the last argument may. */
	readonly variadic?: true;
}

export interface HelpRow {
	readonly command: string;
	readonly description?: string;
}

export type Flags = Readonly<Record<string, FlagSpec>>;

export interface CommandSpec {
	/** The words after `buncargo`, e.g. `stop` or `hosts install`. */
	readonly name: string;
	/** One line, for the root help and this command's own. */
	readonly summary: string;
	/** Built from the name, arguments and flags when absent. */
	readonly usage?: string;
	/** Keyed by the long name without dashes: `"dry-run"` is `--dry-run`. */
	readonly flags: Flags;
	readonly args?: readonly ArgSpec[];
	/** What the arguments after `--` are for. Without it, `--` takes none. */
	readonly passthrough?: string;
	/**
	 * Hand undeclared flags and every positional to the command in order, as
	 * `buncargo prisma` does for Prisma's own arguments. `--help` is then
	 * buncargo's only before the first positional.
	 */
	readonly forwardUnknown?: true;
	readonly notes?: readonly HelpRow[];
	readonly examples?: readonly HelpRow[];
}

type FlagValue<F extends FlagSpec> = F["kind"] extends "boolean"
	? boolean
	: F["kind"] extends "string"
		? string | undefined
		: string | true | undefined;

export type FlagValues<F extends Flags> = {
	readonly [K in keyof F]: FlagValue<F[K]>;
};

/** The positionals as a tuple: required ones are strings, optional ones may be missing. */
type ArgValues<A> = A extends readonly [infer Head, ...infer Tail]
	? Head extends { variadic: true }
		? Head extends { required: true }
			? [string, ...string[]]
			: string[]
		: [
				Head extends { required: true } ? string : string | undefined,
				...ArgValues<Tail>,
			]
	: string[];

export interface Parsed<S extends CommandSpec> {
	readonly values: FlagValues<S["flags"]>;
	readonly positionals: Readonly<ArgValues<S["args"]>>;
	/** The arguments after `--`. */
	readonly passthrough: readonly string[];
}

export type ParseResult<S extends CommandSpec> =
	{ readonly help: true } | ({ readonly help: false } & Parsed<S>);

/**
 * Every code a command exits with and what it means. Each code means one
 * thing everywhere: 0 success, 1 failure or bad arguments, 2 no such target,
 * 3 refused (left as it was), 128 + N a signal.
 */
export type ExitCodes = Readonly<Record<number, string>>;

export const BASE_EXITS = {
	0: "success",
	1: "failed, or bad arguments",
} as const satisfies ExitCodes;

export interface Command<S extends CommandSpec = CommandSpec> {
	readonly spec: S;
	readonly exits: ExitCodes;
	/** The exported type of the JSON document this command prints. */
	readonly json?: string;
	/** The exit code; nothing means 0. */
	run(parsed: Parsed<S>): Promise<number | undefined> | number | undefined;
}

/** A command made of subcommands, e.g. `hosts install`. */
export interface CommandGroup {
	readonly spec: Pick<CommandSpec, "name" | "summary" | "usage">;
	readonly subcommands: Readonly<Record<string, AnyCommand>>;
	/** What runs when no subcommand is named. */
	readonly fallback?: AnyCommand;
}

export type AnyCommand = Command | CommandGroup;

export function defineCommand<const S extends CommandSpec>(
	command: Command<S>,
): Command<S> {
	return command;
}

export function defineGroup(group: CommandGroup): CommandGroup {
	return group;
}

function isGroup(command: AnyCommand): command is CommandGroup {
	return "subcommands" in command;
}

const HELP_FLAG: FlagSpec = {
	kind: "boolean",
	short: "h",
	description: "Show this help message",
};

function flagEntries(spec: CommandSpec): [string, FlagSpec][] {
	return [...Object.entries(spec.flags), ["help", HELP_FLAG]];
}

/**
 * Parse `argv` against `spec`. Throws the `ArgumentsError` that lists every problem:
 * an unknown flag, a value on a boolean flag, a missing or invalid value, a
 * flag given twice, too few or too many positionals, or arguments after `--`
 * the command does not take. `--help` (or `-h`) wins over all of them.
 */
export function parseArgs<const S extends CommandSpec>(
	spec: S,
	argv: readonly string[],
): ParseResult<S> {
	const separator = argv.indexOf("--");
	const own = separator === -1 ? [...argv] : argv.slice(0, separator);
	const after = separator === -1 ? [] : argv.slice(separator + 1);
	// Before the tokens: `--count --help` would read `--help` as the count.
	if (
		!spec.forwardUnknown &&
		own.some((arg) => arg === "--help" || arg === "-h")
	)
		return { help: true };
	const entries = flagEntries(spec);
	const flags = new Map(entries);
	const shorts = new Map(
		entries.flatMap(([name, flag]) =>
			flag.short ? [[flag.short, name] as const] : [],
		),
	);
	const { tokens } = parseTokens({
		args: own,
		options: Object.fromEntries(
			entries.map(([name, flag]) => [
				name,
				{
					type: flag.kind === "string" ? "string" : "boolean",
					...(flag.short ? { short: flag.short } : {}),
				},
			]),
		),
		strict: false,
		allowPositionals: true,
		tokens: true,
	});

	const values: Record<string, string | boolean | undefined> = {};
	for (const [name, flag] of Object.entries(spec.flags))
		values[name] = flag.kind === "boolean" ? false : undefined;
	const errors: string[] = [];
	const positionals: string[] = [];
	// `forwardUnknown`: the argv indexes handed on, which keeps a short group
	// such as `-abc` one argument.
	const forwarded = new Set<number>();
	let help = false;

	for (const token of tokens) {
		if (token.kind === "positional") {
			if (spec.forwardUnknown) forwarded.add(token.index);
			else positionals.push(token.value);
			continue;
		}
		if (token.kind !== "option") continue;
		const name = token.rawName.startsWith("--")
			? token.name
			: (shorts.get(token.name) ?? token.name);
		const flag = flags.get(name);
		if (name === "help") {
			// Only `forwardUnknown` gets here: Prisma's own `migrate --help`.
			if (forwarded.size > 0) forwarded.add(token.index);
			else help = true;
			continue;
		}
		if (!flag) {
			if (spec.forwardUnknown) forwarded.add(token.index);
			else errors.push(`Unknown flag: ${token.rawName}`);
			continue;
		}
		const label = `--${name}`;
		if (flag.kind !== "boolean" && values[name] !== undefined) {
			errors.push(`${label} is given twice.`);
			continue;
		}
		if (flag.kind === "boolean") {
			if (token.inlineValue)
				errors.push(
					`${label} takes no value: pass ${label}, not ${own[token.index]}.`,
				);
			else values[name] = true;
			continue;
		}
		if (flag.kind === "optional" && token.value === undefined) {
			values[name] = true;
			continue;
		}
		const value = token.value;
		// `--profile --apps=x` must not read `--apps=x` as the profile.
		if (
			value === undefined ||
			value === "" ||
			(!token.inlineValue && value.startsWith("-"))
		) {
			errors.push(
				`${label} requires a value: ${label}=${flag.value ?? "<value>"}.`,
			);
			continue;
		}
		const problem = flag.validate?.(value);
		if (problem) errors.push(problem);
		else values[name] = value;
	}
	if (help) return { help: true };

	const args = spec.args ?? [];
	if (!spec.forwardUnknown) {
		const variadic = args.at(-1)?.variadic === true;
		const extra = variadic ? [] : positionals.slice(args.length);
		if (extra.length > 0)
			errors.push(`Unexpected argument: ${extra.join(" ")}`);
		const missing = args.filter(
			(arg, index) => arg.required && positionals[index] === undefined,
		);
		for (const arg of missing) errors.push(`Missing ${arg.name}.`);
	}
	if (after.length > 0 && !spec.passthrough && !spec.forwardUnknown)
		errors.push(`${spec.name} takes no arguments after --: ${after.join(" ")}`);
	if (errors.length > 0) throw argumentsError(errors, spec.name);

	return {
		help: false,
		values: values as FlagValues<S["flags"]>,
		positionals: (spec.forwardUnknown
			? [
					...[...forwarded].map((index) => own[index] ?? ""),
					...(separator === -1 ? [] : argv.slice(separator)),
				]
			: positionals) as unknown as Parsed<S>["positionals"],
		passthrough: spec.forwardUnknown ? [] : after,
	};
}

/**
 * Parse `argv` for `command` (a group picks its subcommand by the first
 * argument) and run it, or print its help. Resolves to the exit code: 1, after
 * printing why, when the arguments are wrong.
 */
export async function runCommand(
	command: AnyCommand,
	argv: readonly string[],
): Promise<number> {
	try {
		return await dispatchCommand(command, argv);
	} catch (error) {
		if (!(error instanceof ArgumentsError)) throw error;
		// Past Bun's buffer: the process exits right after.
		log.errorNow(error.message, error.hints);
		return 1;
	}
}

async function dispatchCommand(
	command: AnyCommand,
	argv: readonly string[],
): Promise<number> {
	if (!isGroup(command)) {
		const parsed = parseArgs(command.spec, argv);
		if (parsed.help) {
			console.log(formatCommandHelp(command));
			return 0;
		}
		return (await command.run(parsed)) ?? 0;
	}
	const [first, ...rest] = argv;
	const named = first !== undefined && !first.startsWith("-");
	const subcommand = named ? command.subcommands[first] : undefined;
	if (subcommand) return dispatchCommand(subcommand, rest);
	if (first === "--help" || first === "-h") {
		console.log(formatGroupHelp(command));
		return 0;
	}
	const choices = Object.keys(command.subcommands).join(" | ");
	if (named)
		throw argumentsError(
			[
				`Unknown ${command.spec.name} command: ${first}`,
				`Use: buncargo ${command.spec.name} ${choices}`,
			],
			command.spec.name,
		);
	if (!command.fallback)
		throw argumentsError(
			[`Name a ${command.spec.name} command: ${choices}`],
			command.spec.name,
		);
	return dispatchCommand(command.fallback, argv);
}

function flagLabel(name: string, flag: FlagSpec): string {
	const value = flag.value ?? "<value>";
	const suffix =
		flag.kind === "boolean"
			? ""
			: flag.kind === "optional"
				? `[=${value}]`
				: `=${value}`;
	return `--${name}${suffix}${flag.short ? `, -${flag.short}` : ""}`;
}

/** `buncargo <usage>`, built from the spec unless it names its own. */
export function commandUsage(spec: CommandSpec): string {
	if (spec.usage) return `buncargo ${spec.usage}`;
	const args = (spec.args ?? []).map((arg) => {
		const name = arg.variadic ? `${arg.name}...` : arg.name;
		return arg.required ? name : `[${name}]`;
	});
	const options = Object.keys(spec.flags).length > 0 ? ["[options]"] : [];
	const rest = spec.passthrough ? ["[-- <args>]"] : [];
	return ["buncargo", spec.name, ...args, ...options, ...rest].join(" ");
}

function padRows(rows: readonly HelpRow[]): string[] {
	const width = Math.max(0, ...rows.map((row) => row.command.length));
	return rows.map((row) =>
		row.description
			? `  ${row.command.padEnd(width)}  ${row.description}`
			: `  ${row.command}`,
	);
}

function exitRows(exits: ExitCodes): HelpRow[] {
	return Object.entries(exits).map(([code, meaning]) => ({
		command: code,
		description: meaning,
	}));
}

/** What help is made of: a command, or a part of one such as `prisma migration new`. */
type HelpSource = Pick<Command, "spec" | "exits" | "json">;

/** Arguments, options, exit codes, JSON and examples: help after its header. */
function commandSections(command: HelpSource): string[] {
	const { spec } = command;
	const sections: string[] = [];
	if (spec.args?.length)
		sections.push(
			"",
			"Arguments:",
			...padRows(
				spec.args.map((arg) => ({
					command: arg.name,
					description: arg.description,
				})),
			),
		);
	sections.push(
		"",
		"Options:",
		...padRows([
			...flagEntries(spec).map(([name, flag]) => ({
				command: flagLabel(name, flag),
				description: flag.description,
			})),
			...(spec.passthrough
				? [{ command: "--", description: spec.passthrough }]
				: []),
			...(spec.notes ?? []),
		]),
		"",
		"Exit codes:",
		...padRows(exitRows(command.exits)),
	);
	if (command.json) sections.push("", `JSON output: ${command.json}`);
	if (spec.examples?.length)
		sections.push("", "Examples:", ...padRows(spec.examples));
	return sections;
}

export function formatCommandHelp(command: HelpSource): string {
	const sections = [
		`Usage: ${commandUsage(command.spec)}`,
		"",
		command.spec.summary,
		...commandSections(command),
	];
	return `\n${sections.join("\n")}\n`;
}

/** The subcommands, and the options of what runs without one. */
function formatGroupHelp(group: CommandGroup): string {
	const { name } = group.spec;
	const fallback =
		group.fallback && !isGroup(group.fallback) ? group.fallback : undefined;
	const sections = [
		`Usage: buncargo ${group.spec.usage ?? `${name} <command>`}`,
		"",
		group.spec.summary,
		"",
		"Commands:",
		...padRows(
			Object.entries(group.subcommands).map(([sub, command]) => ({
				command: sub,
				description: command.spec.summary,
			})),
		),
		...(fallback
			? [
					"",
					`Without a command: ${fallback.spec.summary}`,
					...commandSections(fallback),
				]
			: []),
		"",
		`Run "bunx buncargo ${name} <command> --help" for a command's options.`,
	];
	return `\n${sections.join("\n")}\n`;
}

/** Every command, a group's subcommands one by one, each once. */
function leafCommands(commands: readonly AnyCommand[]): Command[] {
	const seen = new Set<AnyCommand>();
	const leaves: Command[] = [];
	const visit = (command: AnyCommand) => {
		if (seen.has(command)) return;
		seen.add(command);
		if (!isGroup(command)) {
			leaves.push(command);
			return;
		}
		for (const sub of Object.values(command.subcommands)) visit(sub);
		if (command.fallback) visit(command.fallback);
	};
	for (const command of commands) visit(command);
	return leaves;
}

/**
 * The exit codes beyond 0 and 1, one row per command and code, and the JSON
 * documents: the `help agents exits` topic.
 */
export function formatExitCodeTable(commands: readonly AnyCommand[]): string {
	const leaves = leafCommands(commands);
	const rows = leaves.flatMap((command) =>
		Object.entries(command.exits)
			.filter(([code]) => Number(code) > 1)
			.map(([code, meaning]) => [command.spec.name, code, meaning] as const),
	);
	const nameWidth = Math.max(0, ...rows.map(([name]) => name.length));
	const codeWidth = Math.max(0, ...rows.map(([, code]) => code.length));
	const documents = leaves.flatMap((command) =>
		command.json
			? [{ command: command.spec.name, description: command.json }]
			: [],
	);
	return [
		"## Exit codes and JSON",
		"",
		"Every command exits 0 on success and 1 on a failure or bad arguments; a",
		"command that runs another passes its code on. Other codes, by command:",
		"",
		...rows.map(
			([name, code, meaning]) =>
				`  ${name.padEnd(nameWidth)}  ${code.padStart(codeWidth)}  ${meaning}`,
		),
		"",
		"JSON documents, by the type that describes each:",
		"",
		...padRows(documents),
	].join("\n");
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

/** `--apps=a,b` as names, empty entries dropped. */
export function commaList(value: string): string[] {
	return value
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}
