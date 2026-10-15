import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { isCI } from "../runtime-flags";
import { projectStateFilePath } from "../state-paths";
import { formatStep, formatWarn } from "../style";
import { resolveRepoKey } from "./repo-key";
import {
	type CheckoutFileSpec,
	checkoutFileErrors,
	checkoutFileSpecs,
} from "./spec";
import {
	MAX_FILE_BYTES,
	type Manifest,
	readManifest,
	readStoreData,
	type StoreWrite,
	sha256,
	storeDir,
	withStoreLock,
	writeFileAtomic,
	writeStoreEntries,
} from "./store";

/**
 * Keeping each checkout's copy of its checkout files in step with the file
 * store, without ever overwriting local edits. The table it implements is in
 * docs/internals/checkout-files.md; {@link syncAction} is that table.
 */

export type FileState =
	| "in-sync"
	| "store-newer"
	| "local-edits"
	| "conflict"
	| "missing";

/** A file's state from three hashes: the checkout's copy, its base, the store's. */
export function fileState(
	local: string | undefined,
	base: string | undefined,
	store: string | undefined,
): FileState {
	if (local === undefined)
		return store === undefined ? "missing" : "store-newer";
	if (store === undefined) return "local-edits";
	if (local === store) return "in-sync";
	if (base === local) return "store-newer";
	if (base === undefined || base === store) return "local-edits";
	return "conflict";
}

export type SyncAction =
	| "none"
	| "record-base"
	/** store → checkout */
	| "copy"
	/** checkout → store */
	| "adopt"
	/** the template → checkout, not stored */
	| "template"
	/** local edits or a conflict: left alone */
	| "leave";

export function syncAction(
	local: string | undefined,
	base: string | undefined,
	store: string | undefined,
): SyncAction {
	if (local === undefined) return store === undefined ? "template" : "copy";
	if (store === undefined) return "adopt";
	if (local === store) return base === local ? "none" : "record-base";
	if (base === local) return "copy";
	return "leave";
}

export interface CheckoutFileStatus {
	path: string;
	state: FileState;
	machine: boolean;
	/** Why buncargo will not read or write this file, when it will not. */
	refusal?: string;
}

export interface CheckoutFilesReport {
	repoKey: string;
	files: CheckoutFileStatus[];
}

type Log = (line: string) => void;

export interface CheckoutFilesOptions {
	/** Relocates `~/.buncargo` the way `HOME` does. */
	home?: string;
	/** Status lines; never values. Defaults to stderr. */
	log?: Log;
}

const STATE_FILE = "files.json";

type CheckoutState = Record<string, { base: string }>;

function readCheckoutState(root: string): CheckoutState {
	let value: { version?: unknown; files?: Record<string, { base?: unknown }> };
	try {
		const text = readFileSync(projectStateFilePath(root, STATE_FILE), "utf8");
		value = JSON.parse(text);
	} catch {
		// Never synced, or damaged: every file starts without a base.
		return {};
	}
	if (value?.version !== 1 || typeof value.files !== "object") return {};

	const files: CheckoutState = {};
	for (const [path, entry] of Object.entries(value.files ?? {})) {
		const base = entry?.base;
		if (typeof base === "string") files[path] = { base };
	}
	return files;
}

function writeCheckoutState(root: string, files: CheckoutState): void {
	writeFileAtomic(
		projectStateFilePath(root, STATE_FILE),
		`${JSON.stringify({ version: 1, files }, null, 2)}\n`,
		{ dirMode: 0o755 },
	);
}

interface Local {
	data?: Buffer;
	/** Exists but cannot be used: a symlink, outside the checkout, too large. */
	refusal?: string;
}

function checkoutPath(root: string, path: string): string {
	return join(root, ...path.split("/"));
}

/** A checkout file as it is on disk, refusing what buncargo must not touch. */
function readLocal(root: string, path: string): Local {
	const full = checkoutPath(root, path);
	// A symlinked parent directory would put the file outside the checkout.
	const realRoot = realpathSync(root);
	let ancestor = dirname(full);
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const real = realpathSync(ancestor);
	if (real !== realRoot && !real.startsWith(realRoot + sep))
		return { refusal: "is outside the checkout (through a symlink)" };

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(full);
	} catch {
		return {};
	}
	if (stat.isSymbolicLink()) return { refusal: "is a symlink" };
	if (!stat.isFile()) return { refusal: "is not a regular file" };
	if (stat.size > MAX_FILE_BYTES) return { refusal: "is larger than 1 MiB" };
	return { data: readFileSync(full) };
}

function writeLocal(root: string, path: string, data: Uint8Array): void {
	const full = checkoutPath(root, path);
	let mode = 0o600;
	try {
		mode = statSync(full).mode & 0o777;
	} catch {
		// new file: owner-only, it holds secrets
	}
	writeFileAtomic(full, data, { mode, dirMode: 0o755 });
}

/**
 * Paths git would let through: tracked, or not ignored. One `git
 * check-ignore` for every path, and `git ls-files` only to word a refusal.
 */
export function gitignoreRefusals(
	root: string,
	paths: readonly string[],
): Map<string, string> {
	const refusals = new Map<string, string>();
	if (paths.length === 0) return refusals;
	const ignored = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
		cwd: root,
		encoding: "utf-8",
		input: `${paths.join("\0")}\0`,
	});
	if (ignored.status !== 0 && ignored.status !== 1) {
		for (const path of paths)
			refusals.set(path, "could not be checked against .gitignore");
		return refusals;
	}
	const ignoredPaths = new Set(ignored.stdout.split("\0"));
	const rest = paths.filter((path) => !ignoredPaths.has(path));
	if (rest.length === 0) return refusals;
	const tracked = new Set(
		spawnSync("git", ["ls-files", "-z", "--", ...rest], {
			cwd: root,
			encoding: "utf-8",
		}).stdout.split("\0"),
	);
	for (const path of rest)
		refusals.set(
			path,
			tracked.has(path) ? "is tracked by git" : "is not gitignored",
		);
	return refusals;
}

interface View {
	spec: CheckoutFileSpec;
	local: Local;
	localHash?: string;
	base?: string;
	store?: { hash: string; data: Buffer; machine: boolean };
}

interface Opened {
	repoKey: string;
	dir: string;
	/** Undefined when the store does not exist yet. */
	manifest?: Manifest;
	state: CheckoutState;
	views: View[];
}

/** The checkout's store and every selected file's three versions. */
export function openCheckoutFiles(
	root: string,
	specs: readonly CheckoutFileSpec[],
	options: CheckoutFilesOptions = {},
): Opened {
	const repoKey = resolveRepoKey(root);
	if (!repoKey)
		throw new Error(
			`${root} is not in a git repository, and checkout files need one.`,
		);
	return readOpened(root, specs, repoKey, storeDir(repoKey, options.home));
}

function readOpened(
	root: string,
	specs: readonly CheckoutFileSpec[],
	repoKey: string,
	dir: string,
): Opened {
	const read = readManifest(dir);
	if (read.kind === "unusable")
		throw new Error(
			`Left the file store ${dir} alone: ${read.reason}. Update buncargo, or move the directory aside.`,
		);
	const manifest = read.kind === "ok" ? read.manifest : undefined;
	const state = readCheckoutState(root);
	const views = specs.map((spec): View => {
		const local = readLocal(root, spec.path);
		const entry = manifest?.files[spec.path];
		const data = entry ? readStoreData(dir, spec.path, entry) : undefined;
		return {
			spec,
			local,
			localHash: local.data ? sha256(local.data) : undefined,
			base: state[spec.path]?.base,
			store:
				entry && data
					? { hash: entry.sha256, data, machine: entry.machine }
					: undefined,
		};
	});
	return { repoKey, dir, manifest, state, views };
}

function stateOf(view: View): FileState {
	return fileState(view.localHash, view.base, view.store?.hash);
}

function reportOf(
	opened: Opened,
	refusals: ReadonlyMap<string, string>,
): CheckoutFilesReport {
	return {
		repoKey: opened.repoKey,
		files: opened.views.map((view) => {
			const refusal = view.local.refusal ?? refusals.get(view.spec.path);
			return {
				path: view.spec.path,
				state: stateOf(view),
				machine: view.spec.machine,
				...(refusal ? { refusal } : {}),
			};
		}),
	};
}

function selectSpecs(
	specs: readonly CheckoutFileSpec[],
	paths: readonly string[] | undefined,
): CheckoutFileSpec[] {
	if (!paths || paths.length === 0) return [...specs];
	return paths.map((path) => {
		const spec = specs.find((entry) => entry.path === path);
		if (!spec)
			throw new Error(
				`${path} is not in options.checkoutFiles (${specs.map((entry) => entry.path).join(", ") || "none configured"}).`,
			);
		return spec;
	});
}

/** Every file's state, refusals included. Reads only. */
export function inspectCheckoutFiles(
	root: string,
	specs: readonly CheckoutFileSpec[],
	options: CheckoutFilesOptions = {},
): CheckoutFilesReport {
	const opened = openCheckoutFiles(root, specs, options);
	return reportOf(
		opened,
		gitignoreRefusals(
			root,
			opened.views.map((view) => view.spec.path),
		),
	);
}

function readTemplate(
	root: string,
	spec: CheckoutFileSpec,
): Buffer | undefined {
	return spec.template ? readLocal(root, spec.template).data : undefined;
}

const lastReports = new Map<string, CheckoutFilesReport>();

/**
 * What the last sync in this process found for a checkout, so `dev`'s check
 * reports it without forking git again.
 */
export function lastSyncReport(root: string): CheckoutFilesReport | undefined {
	return lastReports.get(root);
}

const defaultLog: Log = (line) => console.error(line);

function warnRefusal(log: Log, path: string, refusal: string): void {
	const fix =
		refusal === "is not gitignored"
			? " `buncargo setup` adds it to .gitignore."
			: refusal === "is tracked by git"
				? ` Untrack it with \`git rm --cached ${path}\` and gitignore it.`
				: "";
	log(formatWarn(`Skipped ${path}: it ${refusal}.${fix}`));
}

/**
 * Apply the sync table to a checkout (`pull` and every command's load).
 *
 * Reads without the lock; only when something has to be written does it take
 * the store's lock and read again, so the common, in-step case writes nothing
 * and forks git once.
 */
export async function syncCheckoutFiles(
	root: string,
	specs: readonly CheckoutFileSpec[],
	options: CheckoutFilesOptions & {
		paths?: readonly string[];
		/** Back up local edits and take the store's copy. */
		force?: boolean;
		/** Only when a store exists, so a CI run never invents one. */
		ci?: boolean;
	} = {},
): Promise<CheckoutFilesReport> {
	const log = options.log ?? defaultLog;
	const selected = selectSpecs(specs, options.paths);
	let opened = openCheckoutFiles(root, selected, options);
	if (options.ci && !opened.manifest) {
		// Nothing to sync from, and a CI job's files are its own business.
		const report = { repoKey: opened.repoKey, files: [] };
		if (!options.paths) lastReports.set(root, report);
		return report;
	}

	const plan = (view: View): Planned => {
		const action = syncAction(view.localHash, view.base, view.store?.hash);
		if (action === "leave" && options.force && view.store) return "force";
		if (action === "template" && !readTemplate(root, view.spec)) return "none";
		return action;
	};
	const needsWrite = (view: View) => !["none", "leave"].includes(plan(view));

	let refusals = new Map<string, string>();
	if (opened.views.some(needsWrite))
		await withStoreLock(opened.dir, () => {
			opened = readOpened(root, selected, opened.repoKey, opened.dir);
			refusals = apply(root, opened, plan, log);
			opened = readOpened(root, selected, opened.repoKey, opened.dir);
		});

	for (const view of opened.views) {
		if (stateOf(view) !== "conflict" || view.local.refusal) continue;
		const path = view.spec.path;
		log(
			formatWarn(
				`${path} has local edits and the file store changed too. Keep yours with \`buncargo files save ${path}\`, or take the store's with \`buncargo files pull --force ${path}\` (yours is backed up).`,
			),
		);
	}
	const report = reportOf(opened, refusals);
	if (!options.paths) lastReports.set(root, report);
	return report;
}

type Planned = SyncAction | "force";

/** Carry out a plan under the lock; returns the gitignore refusals it met. */
function apply(
	root: string,
	opened: Opened,
	plan: (view: View) => Planned,
	log: Log,
): Map<string, string> {
	const now = new Date();
	const actions = new Map(opened.views.map((view) => [view, plan(view)]));
	const writing = opened.views.filter((view) => {
		const action = actions.get(view);
		return action !== "none" && action !== "leave" && action !== "record-base";
	});
	const refusals = gitignoreRefusals(
		root,
		writing.map((view) => view.spec.path),
	);

	const storeWrites: StoreWrite[] = [];
	const state = { ...opened.state };
	for (const view of opened.views) {
		const { path, machine } = view.spec;
		const action = actions.get(view) ?? "none";
		const refusal = view.local.refusal ?? refusals.get(path);
		if (refusal && writing.includes(view)) {
			warnRefusal(log, path, refusal);
			continue;
		}
		switch (action) {
			case "record-base":
				if (view.localHash) state[path] = { base: view.localHash };
				break;
			case "copy":
			case "force": {
				if (!view.store) break;
				if (action === "force" && view.local.data) {
					const stamp = now.toISOString().replace(/[:.]/g, "-");
					const backup = `.buncargo/files-backup/${stamp}/${path}`;
					writeLocal(root, backup, view.local.data);
					log(
						formatStep(
							`Replaced ${path} with the file store's copy; yours is in ${backup}`,
						),
					);
				} else
					log(
						formatStep(
							view.local.data
								? `Updated ${path} from the file store`
								: `Copied ${path} from the file store`,
						),
					);
				writeLocal(root, path, view.store.data);
				state[path] = { base: view.store.hash };
				break;
			}
			case "adopt":
				if (!view.local.data || !view.localHash) break;
				storeWrites.push({ path, data: view.local.data, machine });
				state[path] = { base: view.localHash };
				log(formatStep(`Saved ${path} to the file store`));
				break;
			case "template": {
				const data = readTemplate(root, view.spec);
				if (!data) break;
				// Not stored: the next load adopts the copy, filled in or not.
				writeLocal(root, path, data);
				log(
					formatStep(`Created ${path} from ${view.spec.template}; fill it in`),
				);
				break;
			}
			case "none":
			case "leave":
				break;
			default: {
				const exhaustive: never = action;
				throw new Error(
					`Unhandled checkout file action: ${String(exhaustive)}`,
				);
			}
		}
	}

	if (storeWrites.length > 0)
		writeStoreEntries(
			opened.dir,
			opened.manifest ?? { version: 1, files: {} },
			storeWrites,
			now,
		);
	writeCheckoutState(root, state);
	return refusals;
}

/**
 * Checkout → store: share local edits with every other checkout. Refuses a
 * file it cannot read or that git does not ignore.
 */
export async function saveCheckoutFiles(
	root: string,
	specs: readonly CheckoutFileSpec[],
	options: CheckoutFilesOptions & { paths?: readonly string[] } = {},
): Promise<{ failed: string[] }> {
	const log = options.log ?? defaultLog;
	const selected = selectSpecs(specs, options.paths);
	const first = openCheckoutFiles(root, selected, options);
	const failed: string[] = [];
	await withStoreLock(first.dir, () => {
		const opened = readOpened(root, selected, first.repoKey, first.dir);
		const refusals = gitignoreRefusals(
			root,
			opened.views
				.filter((view) => view.local.data)
				.map((view) => view.spec.path),
		);
		const writes: StoreWrite[] = [];
		const state = { ...opened.state };
		for (const view of opened.views) {
			const { path, machine } = view.spec;
			const refusal = view.local.refusal ?? refusals.get(path);
			if (refusal || !view.local.data || !view.localHash) {
				failed.push(path);
				if (refusal) warnRefusal(log, path, refusal);
				else
					log(formatWarn(`${path} is not in this checkout; nothing to save.`));
				continue;
			}
			writes.push({ path, data: view.local.data, machine });
			state[path] = { base: view.localHash };
			if (view.store?.hash !== view.localHash)
				log(formatStep(`Saved ${path} to the file store`));
		}
		if (writes.length > 0)
			writeStoreEntries(
				opened.dir,
				opened.manifest ?? { version: 1, files: {} },
				writes,
			);
		writeCheckoutState(root, state);
	});
	return { failed };
}

/** Keys added, removed and changed from the store's copy to the checkout's. Never values. */
export function dotenvKeyDiff(
	checkout: Uint8Array,
	store: Uint8Array,
): { added: string[]; removed: string[]; changed: string[] } {
	const decoder = new TextDecoder();
	const mine = parseEnv(decoder.decode(checkout));
	const theirs = parseEnv(decoder.decode(store));
	const keys = (values: object) => Object.keys(values).sort();
	return {
		added: keys(mine).filter((key) => !(key in theirs)),
		removed: keys(theirs).filter((key) => !(key in mine)),
		changed: keys(mine).filter(
			(key) => key in theirs && mine[key] !== theirs[key],
		),
	};
}

/**
 * The loader's sync: run before `envFiles` are read, so a fresh checkout has
 * them. A failure is a warning, never a failed load; a required `envFiles`
 * entry that is still missing gets an error naming the fix.
 */
export async function syncConfiguredCheckoutFiles(
	root: string,
	config: unknown,
): Promise<void> {
	const options = (config as { options?: Record<string, unknown> } | undefined)
		?.options;
	const raw = options?.checkoutFiles;
	// An invalid value is reported by config validation, with the others.
	if (!raw || checkoutFileErrors(raw).length > 0) return;
	const specs = checkoutFileSpecs(raw);
	if (specs.length === 0) return;
	try {
		await syncCheckoutFiles(root, specs, { ci: isCI() });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(formatWarn(`Checkout files were not synced: ${reason}`));
	}

	const envFiles = Array.isArray(options?.envFiles) ? options.envFiles : [];
	for (const entry of envFiles) {
		const file = typeof entry === "string" ? { path: entry } : entry;
		if (file?.optional || typeof file?.path !== "string") continue;
		const spec = specs.find(
			(candidate) =>
				resolve(root, file.path) === checkoutPath(root, candidate.path),
		);
		if (spec && !existsSync(checkoutPath(root, spec.path)))
			throw new Error(
				`${spec.path} is missing, and this machine's file store does not have it. Run \`buncargo files save ${spec.path}\` in a checkout that has it, or \`buncargo files export\` on a machine that has it and \`buncargo files import\` here.`,
			);
	}
}
