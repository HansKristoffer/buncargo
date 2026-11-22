import { existsSync, type FSWatcher, watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import { debounce } from "hanzio";
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
const DEFAULT_DEBOUNCE_MS = 50;

/** Compile ignore globs once so each fs event matches without allocating. */
function compileIgnoreMatcher(
	ignore: readonly string[] = [],
): (path: string) => boolean {
	const globs: Bun.Glob[] = [];
	const seen = new Set<string>();
	const add = (pattern: string) => {
		if (seen.has(pattern)) return;
		seen.add(pattern);
		globs.push(new Bun.Glob(pattern));
	};

	for (const pattern of [...DEFAULT_IGNORE, ...ignore]) {
		add(pattern);
		// `dist/**` should also catch `dist` itself.
		const bare = pattern.replace(/\/\*\*$/, "");
		if (bare !== pattern) add(bare);
	}

	return (path: string) => {
		const normalized = path.split("\\").join("/");
		return globs.some((glob) => glob.match(normalized));
	};
}

// Lazy so importing `buncargo/api` under Node (where `Bun` is absent) does not
// touch `Bun.Glob` at module evaluation time.
let cachedDefaultIgnoreMatcher: ((path: string) => boolean) | undefined;
function getDefaultIgnoreMatcher(): (path: string) => boolean {
	cachedDefaultIgnoreMatcher ??= compileIgnoreMatcher();
	return cachedDefaultIgnoreMatcher;
}

/** Whether a changed path, relative to the app's directory, is ignored. */
export function isIgnoredChange(
	path: string,
	ignore: readonly string[] = [],
): boolean {
	if (ignore.length === 0) return getDefaultIgnoreMatcher()(path);
	return compileIgnoreMatcher(ignore)(path);
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
	const ignored = config.ignore?.length
		? compileIgnoreMatcher(config.ignore)
		: getDefaultIgnoreMatcher();
	let changed: string | undefined;

	// Names the first file of the burst, not the last.
	const fire = debounce(() => {
		const reason = `${changed} changed`;
		changed = undefined;
		if (!signal.aborted) input.onChange(reason);
	}, config.debounceMs ?? DEFAULT_DEBOUNCE_MS);

	const schedule = (path: string) => {
		if (signal.aborted || ignored(path)) return;
		changed ??= path;
		fire();
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
			fire.cancel();
			for (const watcher of watchers) watcher.close();
		},
		{ once: true },
	);
}
