import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
	type CheckoutFileSpec,
	checkoutFileErrors,
	checkoutFileSpecs,
	dotenvKeyDiff,
	exportBundle,
	importBundle,
	inspectCheckoutFiles,
	openCheckoutFiles,
	parseBundle,
	resolveRepoKey,
	saveCheckoutFiles,
	storeDir,
	syncCheckoutFiles,
} from "../../core/checkout-files";
import { findMonorepoRoot } from "../../core/ports";
import { findConfigFile } from "../../loader";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";
import { describeCheckoutFile } from "../core-checks";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

/**
 * `buncargo files`: the checkout's copies of `options.checkoutFiles` and this
 * machine's file store. Prints paths, states and key names, never values.
 */

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	json: {
		name: "--json",
		kind: "boolean",
		description: "status: machine-readable output",
	},
	force: {
		name: "--force",
		kind: "boolean",
		description:
			"pull: replace local edits, backed up to .buncargo/files-backup/",
	},
	includeMachine: {
		name: "--include-machine",
		kind: "boolean",
		description: "export: include machine: true files",
	},
} as const satisfies Record<string, FlagSpec>;

export const FILES_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo files <command> [path...]",
	flags: Object.values(FLAGS),
	notes: [
		{ command: "status [--json]", description: "Each file's state" },
		{
			command: "save [path...]",
			description: "Checkout → file store, so other checkouts get it",
		},
		{
			command: "pull [path...] [--force]",
			description:
				"File store → checkout; never over local edits without --force",
		},
		{
			command: "diff [path]",
			description: "Keys added, removed and changed, never values",
		},
		{
			command: "export [--include-machine]",
			description: "The file store as a bundle on stdout",
		},
		{
			command: "import [-|file]",
			description: "Write a bundle into the file store",
		},
	],
	examples: [
		{
			command:
				"buncargo files export | ssh box 'cd app && bunx buncargo files import'",
			description: "Copy them to another machine",
		},
	],
};

const SUBCOMMANDS = ["status", "save", "pull", "diff", "export", "import"];

/** `options.checkoutFiles` from the config module, without building an environment. */
async function loadCheckoutFiles(): Promise<{
	root: string;
	specs: CheckoutFileSpec[];
}> {
	const found = findConfigFile(process.cwd());
	if (!found)
		throw new CliError(
			"No config file found. Run this inside a checkout with a dev.config.ts.",
		);
	const configPath = realpathSync(found);
	const root = realpathSync(findMonorepoRoot(dirname(configPath)));
	const mod = (await import(configPath)) as {
		default?: { options?: { checkoutFiles?: unknown } };
	};
	const raw = mod.default?.options?.checkoutFiles;
	const errors = checkoutFileErrors(raw);
	if (errors.length > 0) throw new CliError(errors[0] ?? "", errors.slice(1));
	return { root, specs: checkoutFileSpecs(raw) };
}

function requireSpecs(specs: readonly CheckoutFileSpec[]): void {
	if (specs.length === 0)
		throw new CliError("dev.config.ts lists no checkout files.", [
			"Add them: options: { checkoutFiles: ['.env.local'] }",
		]);
}

const STATE_LABELS = {
	"in-sync": "in sync",
	"store-newer": "store newer",
	"local-edits": "local edits",
	conflict: "conflict",
	missing: "missing",
} as const;

export async function handleFiles(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(FILES_COMMAND_SPEC));
		return 0;
	}
	const [command, ...paths] = readPositionals(FILES_COMMAND_SPEC, args);
	const errors = findUnknownFlags(FILES_COMMAND_SPEC, args).map(
		(flag) => `Unknown flag: ${flag}`,
	);
	if (!command || !SUBCOMMANDS.includes(command))
		errors.push(
			command
				? `Unknown files command: ${command}`
				: `buncargo files needs a command: ${SUBCOMMANDS.join(" | ")}`,
		);
	if ((command === "diff" || command === "import") && paths.length > 1)
		errors.push(`Unexpected argument: ${paths[1]}`);
	if ((command === "status" || command === "export") && paths.length > 0)
		errors.push(`Unexpected argument: ${paths[0]}`);
	if (errors.length > 0) throw argumentsError(errors, "files");

	const { root, specs } = await loadCheckoutFiles();
	const selected = paths.length > 0 && command !== "import" ? paths : undefined;
	try {
		switch (command) {
			case "status":
				return status(root, specs, readBooleanFlag(args, FLAGS.json));
			case "save":
				return await save(root, specs, selected);
			case "pull":
				return await pull(
					root,
					specs,
					selected,
					readBooleanFlag(args, FLAGS.force),
				);
			case "diff":
				return diff(root, specs, selected);
			case "export":
				return await exportFiles(
					root,
					specs,
					readBooleanFlag(args, FLAGS.includeMachine),
				);
			case "import":
				return await importFiles(root, specs, paths[0]);
			default:
				throw new CliError(`Unknown files command: ${command}`);
		}
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(error instanceof Error ? error.message : String(error));
	}
}

function status(
	root: string,
	specs: readonly CheckoutFileSpec[],
	json: boolean,
): number {
	const report = inspectCheckoutFiles(root, specs);
	if (json) {
		console.log(
			JSON.stringify(
				{
					version: 1,
					repoKey: report.repoKey,
					files: report.files.map(({ path, state, machine }) => ({
						path,
						state,
						machine,
					})),
				},
				null,
				2,
			),
		);
		return 0;
	}
	log.line(`File store: ${storeDir(report.repoKey)}`);
	if (report.files.length === 0) log.line("No checkout files configured.");
	const width = Math.max(0, ...report.files.map((file) => file.path.length));
	for (const file of report.files) {
		const [problem] = describeCheckoutFile(file);
		const machine = file.machine ? " (this machine only)" : "";
		log.line(
			`  ${file.path.padEnd(width)}  ${STATE_LABELS[file.state]}${machine}${problem ? `: ${problem}` : ""}`,
		);
	}
	return 0;
}

async function save(
	root: string,
	specs: readonly CheckoutFileSpec[],
	paths: readonly string[] | undefined,
): Promise<number> {
	requireSpecs(specs);
	const { failed } = await saveCheckoutFiles(root, specs, { paths });
	if (failed.length === 0)
		log.done("The file store has this checkout's copies.");
	return failed.length === 0 ? 0 : 1;
}

async function pull(
	root: string,
	specs: readonly CheckoutFileSpec[],
	paths: readonly string[] | undefined,
	force: boolean,
): Promise<number> {
	requireSpecs(specs);
	const report = await syncCheckoutFiles(root, specs, { paths, force });
	// Exit 1 unless every file now matches the store (or neither has it).
	const behind = report.files.filter(
		(file) =>
			file.refusal || (file.state !== "in-sync" && file.state !== "missing"),
	);
	for (const file of behind) {
		const [problem] = describeCheckoutFile(file);
		log.warn(
			file.state === "local-edits" || file.state === "conflict"
				? `${file.path} has local edits, so it was not pulled. \`buncargo files pull --force ${file.path}\` replaces them (backed up first).`
				: (problem ?? `${file.path} was not pulled`),
		);
	}
	if (behind.length === 0) log.done("Checkout files match the file store.");
	return behind.length === 0 ? 0 : 1;
}

function diff(
	root: string,
	specs: readonly CheckoutFileSpec[],
	paths: readonly string[] | undefined,
): number {
	requireSpecs(specs);
	const unknown = paths?.find(
		(path) => !specs.some((spec) => spec.path === path),
	);
	if (unknown)
		throw new CliError(`${unknown} is not in options.checkoutFiles.`);
	const opened = openCheckoutFiles(
		root,
		paths ? specs.filter((spec) => paths.includes(spec.path)) : specs,
	);
	for (const view of opened.views) {
		const path = view.spec.path;
		const local = view.local.data;
		const store = view.store?.data;
		if (!local || !store) {
			log.line(
				`${path}: ${local ? "only in this checkout" : store ? "only in the file store" : "in neither"}`,
			);
			continue;
		}
		if (view.localHash === view.store?.hash) {
			log.line(`${path}: same`);
			continue;
		}
		const { added, removed, changed } = dotenvKeyDiff(local, store);
		log.line(`${path}: checkout vs file store`);
		for (const key of added) log.line(`  + ${key}  (only in this checkout)`);
		for (const key of removed) log.line(`  - ${key}  (only in the file store)`);
		for (const key of changed) log.line(`  ~ ${key}  (different values)`);
		if (added.length + removed.length + changed.length === 0)
			log.line("  differs only in comments, order or formatting");
	}
	return 0;
}

async function exportFiles(
	root: string,
	specs: readonly CheckoutFileSpec[],
	includeMachine: boolean,
): Promise<number> {
	// A checkout that has never been synced still has files worth exporting.
	if (specs.length > 0) await syncCheckoutFiles(root, specs);
	const repoKey = resolveRepoKey(root);
	if (!repoKey) throw new CliError(`${root} is not in a git repository.`);
	const bundle = await exportBundle(storeDir(repoKey), repoKey, {
		includeMachine,
	});
	console.log(JSON.stringify(bundle));
	log.hint(
		`Exported ${bundle.files.length} file${bundle.files.length === 1 ? "" : "s"}; the output holds their values.`,
	);
	return 0;
}

async function importFiles(
	root: string,
	specs: readonly CheckoutFileSpec[],
	source: string | undefined,
): Promise<number> {
	const text =
		source === undefined || source === "-"
			? await Bun.stdin.text()
			: readFileSync(source, "utf8");
	const bundle = parseBundle(text);
	const repoKey = resolveRepoKey(root);
	if (!repoKey) throw new CliError(`${root} is not in a git repository.`);
	// A `local/` key is per machine, so it cannot match across machines.
	if (
		bundle.repoKey !== repoKey &&
		!bundle.repoKey.startsWith("local/") &&
		!repoKey.startsWith("local/")
	)
		throw new CliError(
			`The bundle is for ${bundle.repoKey}, and this checkout is ${repoKey}.`,
			["Export it from a checkout of the same repository."],
		);
	await importBundle(storeDir(repoKey), bundle);
	log.done(
		`Imported ${bundle.files.map((file) => file.path).join(", ") || "nothing"} into the file store.`,
	);
	if (specs.length === 0) return 0;
	return pull(root, specs, undefined, false);
}
