import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { debounce } from "hanzio";
import type { ResolvedLinkConfig } from "../types";
import { linkReadyFingerprint, resolveLiveLinksSync } from "./links";
import { getProjectStateDir, getStateDir } from "./state-paths";
import { formatWarn } from "./style";

/**
 * Watch `~/.buncargo/runs.json` (and `<root>/.buncargo/links.json` when
 * present) for settled changes to this checkout's linked repos.
 *
 * Watches parent directories rather than individual files because buncargo
 * writes both registries atomically via temp-file + rename, which replaces the
 * inode on every update.
 */

const RUNS_FILENAME = "runs.json";
const LINKS_FILENAME = "links.json";
const DEFAULT_DEBOUNCE_MS = 150;

export interface WatchLinksOptions {
	readonly root: string;
	readonly linksConfig: Readonly<Record<string, ResolvedLinkConfig>>;
	readonly signal: AbortSignal;
	/** Coalesce rapid registry writes (such as multiple apps becoming ready). Default: 150ms. */
	readonly debounceMs?: number;
	readonly onChange: (changedAliases: readonly string[]) => void;
}

/**
 * Snapshot initial settled fingerprints for every non-disabled link and call
 * `onChange` whenever one or more links transition to a new settled state.
 */
export function watchLinks(options: WatchLinksOptions): void {
	const { root, linksConfig, signal } = options;
	if (signal.aborted) return;

	const activeSpecs = Object.entries(linksConfig).filter(
		([, spec]) => !spec.disabled,
	);
	if (activeSpecs.length === 0) return;

	const fingerprints = new Map<string, string>();
	const initial = resolveLiveLinksSync(root, linksConfig);
	for (const [alias, spec] of activeSpecs) {
		const fp = linkReadyFingerprint(initial.links[alias], spec);
		fingerprints.set(alias, fp ?? "down");
	}

	const evaluate = () => {
		if (signal.aborted) return;
		const current = resolveLiveLinksSync(root, linksConfig);
		const changed: string[] = [];

		for (const [alias, spec] of activeSpecs) {
			const next = linkReadyFingerprint(current.links[alias], spec);
			if (next === undefined) continue;
			if (next !== fingerprints.get(alias)) {
				fingerprints.set(alias, next);
				changed.push(alias);
			}
		}

		if (changed.length > 0) {
			options.onChange(changed);
		}
	};

	const fire = debounce(evaluate, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
	const watchers: FSWatcher[] = [];

	const watchFileInDir = (dir: string, targetFile: string, create: boolean) => {
		try {
			if (create && !existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			if (!existsSync(dir)) return;

			const watcher = watch(dir, { persistent: false }, (_event, filename) => {
				if (signal.aborted) return;
				if (filename && String(filename) !== targetFile) return;
				fire();
			});
			watcher.on("error", (error) => {
				if (signal.aborted) return;
				console.warn(
					formatWarn(`link watch (${targetFile}) failed: ${error.message}`),
				);
			});
			watchers.push(watcher);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				formatWarn(`Could not watch ${dir} for link changes: ${message}`),
			);
		}
	};

	watchFileInDir(getStateDir(), RUNS_FILENAME, true);
	watchFileInDir(getProjectStateDir(root), LINKS_FILENAME, true);

	signal.addEventListener(
		"abort",
		() => {
			fire.cancel();
			for (const watcher of watchers) watcher.close();
		},
		{ once: true },
	);
}
