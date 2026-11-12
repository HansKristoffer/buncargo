import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKER_LIST_ARGS } from "./containers";

/** What the fake prints for one command, keyed by its first argument. */
export interface FakeDockerReply {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

/** One container line in the listing's format, for the fake's `ps` reply. */
export function dockerListLine(container: {
	id: string;
	name?: string;
	state?: string;
	status?: string;
	ports?: string;
	composeProject?: string;
	oneOff?: boolean;
	project?: string;
	root?: string;
	worktree?: string;
	service?: string;
	serviceHash?: string;
}): string {
	return [
		container.id,
		container.name ?? container.id,
		container.state ?? "running",
		container.status ?? "Up 1 minute",
		container.ports ?? "",
		container.composeProject ?? container.project ?? "",
		container.oneOff ? "True" : "False",
		container.project ?? "",
		container.root ?? "",
		container.worktree ?? "",
		container.service ?? "",
		container.serviceHash ?? "",
	].join("\t");
}

/**
 * A `docker` binary that answers from `replies` and records every argv it
 * was run with, for counting forks. A command with no reply exits 0 silently.
 * The listing's format is checked, so a fake cannot drift from the parser.
 */
export function fakeDocker(replies: Record<string, FakeDockerReply> = {}) {
	const root = mkdtempSync(join(tmpdir(), "buncargo fake docker "));
	const log = join(root, "calls.jsonl");
	const repliesFile = join(root, "replies.json");
	const script = join(root, "fake.ts");
	const binary = join(root, "docker");
	const setReplies = (next: Record<string, FakeDockerReply>) =>
		writeFileSync(repliesFile, JSON.stringify(next));
	setReplies(replies);
	writeFileSync(
		script,
		`import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const hashes = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key.startsWith("BUNCARGO_SERVICE_HASH_")),
);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, hashes }) + "\\n");
const listArgs = ${JSON.stringify(DOCKER_LIST_ARGS)};
if (args[0] === "ps" && JSON.stringify(args) !== JSON.stringify(listArgs)) {
	console.error("fake docker: unexpected ps " + JSON.stringify(args));
	process.exit(64);
}
const reply = JSON.parse(readFileSync(${JSON.stringify(repliesFile)}, "utf8"))[args[0]] ?? {};
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.exitCode ?? 0);
`,
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(
		binary,
		`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
	);
	chmodSync(binary, 0o700);
	const records = (): {
		args: string[];
		hashes: Record<string, string>;
	}[] => {
		try {
			return readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	return {
		root,
		binary,
		setReplies,
		/** Every argv the fake was run with, in order. */
		calls(): string[][] {
			return records().map((record) => record.args);
		},
		/** The service hashes the last `compose up` was given, by env name. */
		upHashes(): Record<string, string> {
			return (
				records().findLast((record) => record.args.includes("up"))?.hashes ?? {}
			);
		},
		/** Forget the calls so far. */
		resetCalls() {
			writeFileSync(log, "");
		},
		remove() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
