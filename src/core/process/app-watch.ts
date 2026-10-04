import { existsSync, type FSWatcher, watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AppWatchConfig } from "../../types";
import { formatWarn } from "../style";

/**
 * Restarting an app when its files change, with one recursive watcher per
 * path, so the app's own command needs no `--watch`.
 *
 * `bun --watch` keeps about 3,000 descriptors per reload on macOS; a few
 * watched APIs across checkouts filled the machine's file table and failed
 * typecheckers, simulators and browsers with ENFILE. Here every reload is a
 * fresh process (the supervisor's restart: SIGTERM, wait for the exit, spawn),
 * so nothing accumulates, and the watcher is one FSEvents stream per path.
 */

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/.buncargo/**"];
const DEFAULT_DEBOUNCE_MS = 150;

/** Whether a changed path, relative to the app's directory, is ignored. */
export function isIgnoredChange(
	path: string,
	ignore: readonly string[] = [],
): boolean {
	const normalized = path.split("\\").join("/");
	return [...DEFAULT_IGNORE, ...ignore].some(
		(pattern) =>
			new Bun.Glob(pattern).match(normalized) ||
			// `dist/**` should also catch `dist` itself.
			new Bun.Glob(pattern.replace(/\/\*\*$/, "")).match(normalized),
	);
}

/**
 * Watch an app's paths until `signal` aborts. `onChange` gets one call per
 * burst of changes (an editor's save is several events), naming a file.
 */
export function watchApp(input: {
	name: string;
	/** The app's working directory: `paths` and `ignore` are relative to it. */
	dir: string;
	config: AppWatchConfig;
	signal: AbortSignal;
	onChange(reason: string): void;
}): void {
	const { dir, config, signal } = input;
	const watchers: FSWatcher[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let changed: string | undefined;

	const schedule = (path: string) => {
		if (signal.aborted || isIgnoredChange(path, config.ignore)) return;
		changed ??= path;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const reason = `${changed} changed`;
			changed = undefined;
			if (!signal.aborted) input.onChange(reason);
		}, config.debounceMs ?? DEFAULT_DEBOUNCE_MS);
	};

	for (const path of config.paths) {
		const target = resolve(dir, path);
		if (!existsSync(target)) {
			console.warn(
				formatWarn(`${input.name}: watch path ${path} does not exist`),
			);
			continue;
		}
		const watcher = watch(target, { recursive: true }, (_event, filename) => {
			schedule(
				relative(dir, filename ? join(target, String(filename)) : target),
			);
		});
		watcher.on("error", (error) => {
			console.warn(
				formatWarn(`${input.name}: watching ${path} failed: ${error.message}`),
			);
		});
		watchers.push(watcher);
	}

	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		},
		{ once: true },
	);
}
