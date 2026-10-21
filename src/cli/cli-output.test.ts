import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buncargoVersion } from "../core/version";

/**
 * Pins what each command prints for `--help`, and how the root handles help,
 * version and unknown input. Scripts and CI call these, so a changed or
 * removed line is a breaking change; an added command or flag only adds lines.
 *
 * Runs the real `bin.ts` in an empty directory, so no `dev.config.ts` adds
 * tasks or integration commands to the root help.
 */

const BIN = join(import.meta.dir, "bin.ts");
// The real path: macOS children see `/private/var/...` for a `/var/...` temp dir.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-cli-output-")));
const version = buncargoVersion();
if (!version) throw new Error("buncargo version not found");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function run(args: string[]): string {
	const result = Bun.spawnSync([process.execPath, BIN, ...args], {
		cwd,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	const clean = (text: Buffer) =>
		text
			.toString()
			.replaceAll(`v${version}`, "v<version>")
			.replaceAll(cwd, "<cwd>");
	return [
		`exit ${result.exitCode}`,
		`--- stdout\n${clean(result.stdout)}`,
		`--- stderr\n${clean(result.stderr)}`,
	].join("\n");
}

/** Every command that answers `--help` with its own options. */
const HELP_COMMANDS = [
	["setup"],
	["run"],
	["wait"],
	["generate"],
	["build"],
	["exec"],
	["slot"],
	["connect"],
	["dev"],
	["typecheck"],
	["check"],
	["predeploy"],
	["files"],
	["secrets"],
	["ci"],
	["env", "set"],
	["env", "unset"],
	["url"],
	["open"],
	["stop"],
	["restart"],
	["send"],
	["logs"],
	["ports"],
	["sql"],
	["prune"],
];

describe("buncargo CLI output", () => {
	for (const command of HELP_COMMANDS) {
		it(`${command.join(" ")} --help`, () => {
			expect(run([...command, "--help"])).toMatchSnapshot();
		});
	}

	// The root: help, version, and what is not a command.
	for (const args of [
		[],
		["--help"],
		["-h"],
		["help"],
		["help", "agents"],
		["version"],
		["--version"],
		["-v"],
		["nope"],
		["--nope"],
		// Subcommand namespaces answer unknown input, `--help` included.
		["hosts", "--help"],
		["bar", "--help"],
		["typecheck", "--nope"],
		["stop", "--nope"],
		// 2 is "no such target"; the menu bar app tells it from 3.
		["stop", "nope"],
		// A handler that returns its exit code.
		["wait"],
		["dev", "--nope"],
		["runs", "--json"],
	]) {
		it(`buncargo ${args.join(" ")}`.trimEnd(), () => {
			expect(run(args)).toMatchSnapshot();
		});
	}
});
