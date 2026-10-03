import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findMonorepoRoot } from "../../core/ports";
import { listRunLogDirs } from "../../core/process/app-logs";
import { lineLevel } from "../../core/process/run-output";
import { sleep } from "../../core/sleep";
import { colorizeName } from "../../core/style";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	follow: {
		name: "--follow",
		kind: "boolean",
		description: "Keep printing new lines (-f)",
	},
	since: {
		name: "--since",
		kind: "string",
		valueHint: "=<5m>",
		description: "Only lines newer than this (s, m, h)",
		validate: (value: string) =>
			parseDuration(value) === undefined
				? `--since expects a duration like 30s, 5m or 2h, got "${value}".`
				: undefined,
	},
	errors: {
		name: "--errors",
		kind: "boolean",
		description: "Only lines that read as errors",
	},
	root: {
		name: "--root",
		kind: "string",
		valueHint: "=<path>",
		description: "Checkout whose logs to read (default: this one)",
	},
} as const;

export const LOGS_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo logs [<app>] [options]",
	flags: Object.values(FLAGS),
	examples: [
		{ command: "buncargo logs", description: "Every app, interleaved" },
		{
			command: "buncargo logs shopify --errors",
			description: "What went wrong in one app",
		},
		{ command: "buncargo logs api -f --since=5m", description: "Tail one app" },
	],
};

function parseDuration(value: string): number | undefined {
	const match = /^(\d+)(s|m|h)$/.exec(value.trim());
	if (!match) return undefined;
	const unit = { s: 1000, m: 60_000, h: 3_600_000 }[
		match[2] as "s" | "m" | "h"
	];
	return Number(match[1]) * unit;
}

interface LogLine {
	app: string;
	time: string;
	text: string;
}

/** A log file's lines from `offset` on: `<ISO time> <text>` each. */
function readLines(file: string, app: string, offset = 0): LogLine[] {
	const content = readFileSync(file).subarray(offset).toString("utf8");
	return content
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const space = line.indexOf(" ");
			return { app, time: line.slice(0, space), text: line.slice(space + 1) };
		});
}

/**
 * `buncargo logs`: app output from `.buncargo/logs`, for the current run or
 * the last one. What agents read, and what is left once the terminal scrolled.
 */
export async function handleLogs(rawArgs: string[]): Promise<number> {
	const args = rawArgs.map((arg) => (arg === "-f" ? FLAGS.follow.name : arg));
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(LOGS_COMMAND_SPEC));
		return 0;
	}
	const problems: string[] = [];
	const since = readStringFlag(args, FLAGS.since, problems);
	const root = readStringFlag(args, FLAGS.root, problems) ?? findMonorepoRoot();
	const [app, ...extra] = readPositionals(LOGS_COMMAND_SPEC, args);
	problems.push(
		...findUnknownFlags(LOGS_COMMAND_SPEC, args).map(
			(f) => `Unknown flag: ${f}`,
		),
		...extra.map((arg) => `Unexpected argument: ${arg}`),
	);
	if (problems.length > 0) throw argumentsError(problems, "logs");

	const dir = listRunLogDirs(root).at(-1);
	if (!dir)
		throw new CliError(`No logs yet for ${root}: start \`buncargo dev\`.`);
	const apps = readdirSync(dir)
		.filter((name) => name.endsWith(".log"))
		.map((name) => basename(name, ".log"));
	if (app !== undefined && !apps.includes(app))
		throw new CliError(`No log for "${app}" in ${dir}.`, [
			`Available: ${apps.join(", ") || "(none)"}`,
		]);
	const selected = app === undefined ? apps : [app];
	const after =
		since === undefined
			? undefined
			: new Date(Date.now() - (parseDuration(since) ?? 0)).toISOString();
	const errorsOnly = readBooleanFlag(args, FLAGS.errors);
	const keep = (line: LogLine) =>
		(after === undefined || line.time >= after) &&
		(!errorsOnly || lineLevel(line.text) === "error");
	const print = (line: LogLine) => {
		const time = line.time.slice(11, 19);
		console.log(
			app === undefined
				? `${time} ${colorizeName(line.app)} ${line.text}`
				: `${time} ${line.text}`,
		);
	};

	const offsets = new Map<string, number>();
	const lines: LogLine[] = [];
	for (const name of selected) {
		const file = join(dir, `${name}.log`);
		lines.push(...readLines(file, name));
		offsets.set(name, statSync(file).size);
	}
	for (const line of lines
		.filter(keep)
		.sort((a, b) => a.time.localeCompare(b.time)))
		print(line);

	if (!readBooleanFlag(args, FLAGS.follow)) return 0;
	for (;;) {
		await sleep(300);
		for (const name of app === undefined ? readdirApps(dir) : selected) {
			const file = join(dir, `${name}.log`);
			if (!existsSync(file)) continue;
			const size = statSync(file).size;
			const offset = offsets.get(name) ?? 0;
			// Rotated: the file starts over.
			const from = size < offset ? 0 : offset;
			if (size === from) continue;
			for (const line of readLines(file, name, from).filter(keep)) print(line);
			offsets.set(name, size);
		}
	}
}

function readdirApps(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".log"))
		.map((name) => basename(name, ".log"));
}
