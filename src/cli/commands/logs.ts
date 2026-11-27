import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promiseTimeout } from "hanzio";
import { findMonorepoRoot } from "../../core/ports";
import { isSessionLogDir, listRunLogDirs } from "../../core/process/app-logs";
import { createErrorFilter } from "../../core/process/run-output";
import { findRunsByRoot, type RunEntry } from "../../core/run-registry";
import { colorizeName } from "../../core/style";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { parseSinceDuration } from "../duration";
import { CliError } from "../errors";

const FOLLOW_POLL_MS = 300;

/** How often `-f` asks the registry whether the run is still going. */
const RUN_CHECK_MS = 1_000;

interface LogLine {
	app: string;
	time: string;
	text: string;
}

/** A log file's lines from `offset` on: `<ISO time> <text>` each, reading only `[offset, size)`. */
function readLines(
	file: string,
	app: string,
	offset = 0,
): { lines: LogLine[]; size: number } {
	const fd = openSync(file, "r");
	try {
		const total = fstatSync(fd).size;
		const from = total < offset ? 0 : offset;
		if (total <= from) return { lines: [], size: total };
		const expected = total - from;
		const buf = Buffer.allocUnsafe(expected);
		let bytesRead = 0;
		while (bytesRead < expected) {
			const n = readSync(
				fd,
				buf,
				bytesRead,
				expected - bytesRead,
				from + bytesRead,
			);
			if (n === 0) break;
			bytesRead += n;
		}
		const content = buf.subarray(0, bytesRead).toString("utf8");
		const lines = content
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const space = line.indexOf(" ");
				return { app, time: line.slice(0, space), text: line.slice(space + 1) };
			});
		return { lines, size: from + bytesRead };
	} finally {
		closeSync(fd);
	}
}

/**
 * `buncargo logs`: app output from `.buncargo/logs`, for the current run or
 * the last one. What agents read, and what is left once the terminal scrolled.
 */
async function readLogs(input: {
	root: string;
	app: string | undefined;
	sessionId: string | undefined;
	since: string | undefined;
	errorsOnly: boolean;
	follow: boolean;
}): Promise<number> {
	const { root, app, sessionId, since, errorsOnly } = input;
	const runs = await findRunsByRoot(root).catch((): RunEntry[] => []);
	const dir = pickRunLogDir(listRunLogDirs(root), runs, { app, sessionId });

	if (!dir) {
		const none = sessionId
			? `No logs of run ${sessionId} in ${root}: \`buncargo runs\` lists the live runs.`
			: `No logs yet for ${root}: start \`buncargo dev\`.`;
		throw new CliError(none);
	}

	const apps = readdirApps(dir);
	if (app !== undefined && !apps.includes(app)) {
		throw new CliError(`No log for "${app}" in ${dir}.`, [
			`Available: ${apps.join(", ") || "(none)"}`,
		]);
	}

	const selected = app === undefined ? apps : [app];
	const after =
		since === undefined
			? undefined
			: new Date(Date.now() - (parseSinceDuration(since) ?? 0)).toISOString();

	// One filter per app: an error's structured block follows it in its own
	// file, and the apps' lines are merged only after.
	const errorFilters = new Map<string, (text: string) => boolean>();
	const isError = (line: LogLine) => {
		let filter = errorFilters.get(line.app);
		if (!filter) {
			filter = createErrorFilter();
			errorFilters.set(line.app, filter);
		}
		return filter(line.text);
	};

	const keep = (line: LogLine) =>
		(!errorsOnly || isError(line)) &&
		(after === undefined || line.time >= after);

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
		const read = readLines(file, name);
		lines.push(...read.lines);
		offsets.set(name, read.size);
	}

	const printable = lines
		.filter(keep)
		.sort((a, b) => a.time.localeCompare(b.time));
	for (const line of printable) print(line);

	if (!input.follow) return 0;

	let checkedAt = Date.now();
	for (;;) {
		await promiseTimeout(FOLLOW_POLL_MS);

		// Ends with the run, its last lines printed: read once more first.
		const due = Date.now() - checkedAt >= RUN_CHECK_MS;
		const ended = due && !(await runIsLive(root, dir));
		if (due) checkedAt = Date.now();

		for (const name of app === undefined ? readdirApps(dir) : selected) {
			const file = join(dir, `${name}.log`);
			if (!existsSync(file)) continue;
			try {
				const size = statSync(file).size;
				const offset = offsets.get(name) ?? 0;
				// Rotated: the file starts over.
				const from = size < offset ? 0 : offset;
				if (size === from) continue;

				const read = readLines(file, name, from);
				for (const line of read.lines.filter(keep)) print(line);
				offsets.set(name, read.size);
			} catch (error) {
				// File rotated between `existsSync` and `statSync`/`openSync`: retry next tick.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
		}

		if (ended) return 0;
	}
}

async function runIsLive(root: string, dir: string): Promise<boolean> {
	const runs = await findRunsByRoot(root).catch((): RunEntry[] => []);
	return runs.some((run) => isSessionLogDir(dir, run.sessionId));
}

/**
 * The run directory to read, from `dirs` (oldest first) and the checkout's
 * live `runs`: the asked session's newest, else the newest live run that runs
 * `app`, else the newest directory with a log for `app`, else the newest. Two
 * runs in one checkout (`dev --apps=api`, then `dev --apps=web`) each write
 * their own directory, and the newest is not the one `api` is in.
 */
function pickRunLogDir(
	dirs: readonly string[],
	runs: readonly RunEntry[],
	want: { app: string | undefined; sessionId: string | undefined },
): string | undefined {
	const newestOf = (sessionId: string) =>
		dirs.findLast((dir) => isSessionLogDir(dir, sessionId));

	if (want.sessionId !== undefined) return newestOf(want.sessionId);

	const { app } = want;
	if (app === undefined) return dirs.at(-1);

	const running = runs
		.filter((run) => run.apps.some((entry) => entry.name === app))
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
		.flatMap((run) => newestOf(run.sessionId) ?? []);
	return (
		running.at(-1) ??
		dirs.findLast((dir) => existsSync(join(dir, `${app}.log`))) ??
		dirs.at(-1)
	);
}

function readdirApps(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".log"))
		.map((name) => basename(name, ".log"));
}

export const logsCommand = defineCommand({
	spec: {
		name: "logs",
		summary: "Read app output from the current or last run",
		flags: {
			follow: {
				kind: "boolean",
				short: "f",
				description: "Keep printing new lines until the run ends",
			},
			since: {
				kind: "string",
				value: "<5m>",
				description: "Only lines newer than this (s, m, h)",
				validate: (value: string) =>
					parseSinceDuration(value) === undefined
						? `--since expects a duration like 30s, 5m or 2h, got "${value}".`
						: undefined,
			},
			errors: {
				kind: "boolean",
				description: "Only lines that read as errors",
			},
			root: {
				kind: "string",
				value: "<path>",
				description: "Checkout whose logs to read (default: this one)",
			},
			run: {
				kind: "string",
				value: "<sessionId>",
				description:
					"The run whose logs to read (default: the live run of <app>, else the newest)",
			},
		},
		args: [
			{ name: "<app>", description: "One app's output (default: every app)" },
		],
		examples: [
			{ command: "buncargo logs", description: "Every app, interleaved" },
			{
				command: "buncargo logs shopify --errors",
				description: "What went wrong in one app",
			},
			{
				command: "buncargo logs api -f --since=5m",
				description: "Tail one app",
			},
			{
				command: "buncargo logs --run=<sessionId>",
				description: "One run's apps, by the id `buncargo runs` prints",
			},
		],
	},
	exits: BASE_EXITS,
	run: ({ values, positionals: [app] }) =>
		readLogs({
			root: values.root ?? findMonorepoRoot(),
			app,
			sessionId: values.run,
			since: values.since,
			errorsOnly: values.errors,
			follow: values.follow,
		}),
});
