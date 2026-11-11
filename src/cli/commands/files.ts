import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { getErrorMessage } from "hanzio";
import {
	type CheckoutFileSpec,
	checkoutFileErrors,
	checkoutFileSpecs,
	dotenvKeyDiff,
	exportBundle,
	importBundle,
	inspectCheckoutFiles,
	type MergeAnswers,
	type MergeSide,
	mergeCheckoutFile,
	openCheckoutFiles,
	parseBundle,
	resolveRepoKey,
	saveCheckoutFiles,
	selectSpecs,
	storeDir,
	syncCheckoutFiles,
} from "../../core/checkout-files";
import {
	isDotenvPath,
	loopbackUrlPort,
	readDotenvFile,
} from "../../core/loopback-env";
import { findMonorepoRoot } from "../../core/ports";
import { askChoice, isInteractive } from "../../core/prompt";
import { findConfigFile } from "../../loader";
import {
	BASE_EXITS,
	commaList,
	defineCommand,
	defineGroup,
} from "../command-spec";
import { checkoutFileProblem } from "../core-checks";
import { argumentsError, CliError } from "../errors";
import type { FilesStatusJson } from "../json-documents";
import * as log from "../log";

/**
 * `buncargo files`: the checkout's copies of `options.checkoutFiles` and this
 * machine's file store. Prints paths, states and key names, never values.
 */

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

/** Run `use` on the checkout's files, any failure reported as a `CliError`. */
async function withCheckoutFiles(
	use: (root: string, specs: CheckoutFileSpec[]) => Promise<number> | number,
): Promise<number> {
	const { root, specs } = await loadCheckoutFiles();
	try {
		return await use(root, specs);
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(getErrorMessage(error));
	}
}

/** `--checkout` and `--store`: which side each conflicting key takes. */
function mergeAnswers(
	checkout: string | undefined,
	store: string | undefined,
): Map<string, MergeSide> {
	const errors: string[] = [];
	const take = new Map<string, MergeSide>();
	for (const [side, keys] of [
		["checkout", checkout],
		["store", store],
	] as const)
		for (const key of commaList(keys ?? "")) {
			if (take.has(key) && take.get(key) !== side)
				errors.push(`${key} is in both --checkout and --store.`);
			take.set(key, side);
		}
	if (errors.length > 0) throw argumentsError(errors, "files merge");
	return take;
}

const PATHS_ARG = {
	name: "<path>",
	description: "Only these checkout files (default: every one)",
	variadic: true,
} as const;

const statusCommand = defineCommand({
	spec: {
		name: "files status",
		summary: "Each file's state",
		flags: {
			json: { kind: "boolean", description: "Machine-readable output" },
		},
	},
	exits: BASE_EXITS,
	json: "FilesStatusJson (--json)",
	run: ({ values }) =>
		withCheckoutFiles((root, specs) => status(root, specs, values.json)),
});

const saveCommand = defineCommand({
	spec: {
		name: "files save",
		summary: "Checkout → file store, so other checkouts get it",
		flags: {},
		args: [PATHS_ARG],
	},
	exits: { ...BASE_EXITS, 1: "a file could not be saved, or bad arguments" },
	run: ({ positionals }) =>
		withCheckoutFiles((root, specs) =>
			save(root, specs, positionals.length > 0 ? positionals : undefined),
		),
});

const pullCommand = defineCommand({
	spec: {
		name: "files pull",
		summary: "File store → checkout; never over local edits without --force",
		flags: {
			force: {
				kind: "boolean",
				description:
					"Replace local edits, backed up to .buncargo/files-backup/",
			},
		},
		args: [PATHS_ARG],
	},
	exits: {
		...BASE_EXITS,
		1: "a file does not match the store afterwards, or bad arguments",
	},
	run: ({ values, positionals }) =>
		withCheckoutFiles((root, specs) =>
			pull(
				root,
				specs,
				positionals.length > 0 ? positionals : undefined,
				values.force,
			),
		),
});

const mergeCommand = defineCommand({
	spec: {
		name: "files merge",
		summary:
			"Merge a dotenv file's local edits and the store's changes key by key",
		flags: {
			checkout: {
				kind: "string",
				value: "<KEY,...>",
				description: "Keep this checkout's value of these conflicting keys",
			},
			store: {
				kind: "string",
				value: "<KEY,...>",
				description: "Take the file store's value of these conflicting keys",
			},
		},
		args: [
			{
				name: "<path>",
				description: "The checkout file, e.g. .env.local",
				required: true,
			},
		],
	},
	exits: { ...BASE_EXITS, 1: "keys still conflict (named), or bad arguments" },
	run: ({ values, positionals: [path] }) => {
		const take = mergeAnswers(values.checkout, values.store);
		return withCheckoutFiles((root, specs) => merge(root, specs, path, take));
	},
});

const diffCommand = defineCommand({
	spec: {
		name: "files diff",
		summary: "Keys added, removed and changed, never values",
		flags: {},
		args: [
			{ name: "<path>", description: "One checkout file (default: every one)" },
		],
	},
	exits: BASE_EXITS,
	run: ({ positionals: [path] }) =>
		withCheckoutFiles((root, specs) =>
			diff(root, specs, path === undefined ? undefined : [path]),
		),
});

const exportCommand = defineCommand({
	spec: {
		name: "files export",
		summary: "The file store as a bundle on stdout",
		flags: {
			"include-machine": {
				kind: "boolean",
				description: "Include machine: true files",
			},
		},
		examples: [
			{
				command:
					"buncargo files export | ssh box 'cd app && bunx buncargo files import'",
				description: "Copy them to another machine",
			},
		],
	},
	exits: BASE_EXITS,
	run: ({ values }) =>
		withCheckoutFiles((root, specs) =>
			exportFiles(root, specs, values["include-machine"]),
		),
});

const importCommand = defineCommand({
	spec: {
		name: "files import",
		summary: "Write a bundle into the file store",
		flags: {},
		args: [
			{ name: "<file>", description: "The bundle (default: stdin, or -)" },
		],
	},
	exits: BASE_EXITS,
	run: ({ positionals: [file] }) =>
		withCheckoutFiles((root, specs) => importFiles(root, specs, file)),
});

export const filesCommand = defineGroup({
	spec: {
		name: "files",
		summary: "Gitignored files every checkout needs (.env.local), per machine",
	},
	subcommands: {
		status: statusCommand,
		save: saveCommand,
		pull: pullCommand,
		merge: mergeCommand,
		diff: diffCommand,
		export: exportCommand,
		import: importCommand,
	},
});

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
				} satisfies FilesStatusJson,
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
		const state = checkoutFileProblem(file) ?? STATE_LABELS[file.state];
		const machine = file.machine ? " (this machine only)" : "";
		log.line(`  ${file.path.padEnd(width)}  ${state}${machine}`);
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
	for (const warning of portBoundSharedValues(root, specs, paths))
		log.warn(warning);
	return failed.length === 0 ? 0 : 1;
}

/**
 * A loopback URL with a port is this checkout's port: every checkout that
 * pulls the file connects here, and to nothing once this run ends. Saved
 * anyway, since the store is the developer's; said, because the failure it
 * causes elsewhere is silent.
 */
export function portBoundSharedValues(
	root: string,
	specs: readonly CheckoutFileSpec[],
	paths: readonly string[] | undefined,
): string[] {
	return specs
		.filter(
			(spec) =>
				!spec.machine &&
				isDotenvPath(spec.path) &&
				(!paths || paths.includes(spec.path)),
		)
		.flatMap((spec) => {
			const keys = Object.entries(readDotenvFile(root, spec.path))
				.filter(([, value]) => loopbackUrlPort(value) !== undefined)
				.map(([key]) => key);
			return keys.length === 0
				? []
				: [
						`${spec.path} shares loopback URLs with a fixed port (${keys.join(", ")}): every checkout that pulls it connects to this checkout's ports. Let buncargo inject them (\`env\` in dev.config.ts), or set them per checkout with \`buncargo env set\`.`,
					];
		});
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
		log.warn(
			!file.refusal && file.state === "local-edits"
				? `${file.path} has local edits, so it was not pulled. \`buncargo files pull --force ${file.path}\` replaces them (backed up first).`
				: `${file.path} ${checkoutFileProblem(file) ?? "was not pulled"}`,
		);
	}
	if (behind.length === 0) log.done("Checkout files match the file store.");
	return behind.length === 0 ? 0 : 1;
}

async function merge(
	root: string,
	specs: readonly CheckoutFileSpec[],
	path: string,
	take: Map<string, MergeSide>,
): Promise<number> {
	requireSpecs(specs);
	// Answers hold only for the copies they were given for: the merge reads
	// both again under the lock, and drops them when either changed meanwhile.
	let answered: MergeAnswers | undefined;
	for (let first = true; ; first = false) {
		const result = await mergeCheckoutFile(root, specs, path, {
			take,
			answered,
		});
		const stale = answered !== undefined && answered.inputs !== result.inputs;
		if (stale && result.conflicts.length > 0)
			log.warn(
				`${path} changed in this checkout or the file store while you chose; asking again.`,
			);
		if (stale) answered = undefined;
		if (!result.base && first)
			log.warn(
				`There is no copy of ${path} as it was last synced (an older buncargo synced it), so a key removed on one side is kept from the other.`,
			);
		if (result.conflicts.length === 0) {
			if (!result.merged) log.done(`${path} already matches the file store.`);
			return 0;
		}

		// Ask per key, outside the store's lock; the merge reads both again.
		if (isInteractive()) {
			const asked = new Map(answered?.take);
			for (const key of result.conflicts) {
				const side = await askChoice<MergeSide | undefined>(
					[
						`${key} changed in this checkout and in the file store (values not shown).`,
						"  c = keep this checkout's   s = take the file store's   Enter = stop",
					],
					[
						{ key: "c", value: "checkout" },
						{ key: "s", value: "store" },
						{ key: "", value: undefined },
					],
					undefined,
				);
				if (!side) {
					log.warn(`Stopped; ${path} was not merged.`);
					return 1;
				}
				asked.set(key, side);
			}
			answered = { take: asked, inputs: result.inputs };
			continue;
		}

		const keys = result.conflicts.join(",");
		log.error(
			`${path}: ${result.conflicts.join(", ")} changed in this checkout and in the file store. Nothing was written.`,
		);
		log.hint(
			`Choose per key: buncargo files merge ${path} --checkout=${keys}  (or --store=${keys})`,
		);
		return 1;
	}
}

function diff(
	root: string,
	specs: readonly CheckoutFileSpec[],
	paths: readonly string[] | undefined,
): number {
	requireSpecs(specs);
	const opened = openCheckoutFiles(root, selectSpecs(specs, paths));
	for (const view of opened.views) {
		const path = view.spec.path;
		const local = view.local.data;
		const store = view.store?.kind === "ok" ? view.store.data : undefined;
		if (!local || !store) {
			const where = local
				? "only in this checkout"
				: store
					? "only in the file store"
					: "in neither";
			log.line(`${path}: ${where}`);
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
	const count = bundle.files.length;
	log.hint(
		`Exported ${count} file${count === 1 ? "" : "s"}; the output holds their values.`,
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
	const imported = bundle.files.map((file) => file.path).join(", ");
	log.done(`Imported ${imported || "nothing"} into the file store.`);
	if (specs.length === 0) return 0;
	return pull(root, specs, undefined, false);
}
