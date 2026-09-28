import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findMonorepoRoot } from "../core/ports";
import type { AppConfig } from "../types";

/** Marks an app `discoverApps` produced, for `buncargo build --discovered`. */
const DISCOVERED_APP = Symbol.for("buncargo.discovered");

export interface DiscoverAppsOptions {
	/** Workspace directories, relative to the repo root, e.g. `extensions/*`. */
	globs: readonly string[];
	/** The package script that runs the app. Only workspaces that define it are included. Default: `dev` */
	script?: string;
	/** Default: `worker`. A `server` needs `port`. */
	kind?: "worker" | "server";
	/** Base port for servers; each discovered app takes the next one, in name order. */
	port?: number;
	/**
	 * A package script run once, to completion, before the app's `script`
	 * starts, e.g. `build` so assets exist before a watcher and other tools
	 * read them. Skipped for a workspace that does not define it.
	 */
	prebuild?: string;
	/** Extra fields for every discovered app, e.g. `{ healthEndpoint: '/health' }`. */
	app?: Partial<Omit<AppConfig, "kind" | "port" | "devCommand" | "cwd">>;
	/** Default: the monorepo root of the working directory. */
	root?: string;
}

interface WorkspaceManifest {
	/** Relative to the root, e.g. `apps/web`. */
	dir: string;
	pkg: {
		name?: string;
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
}

/** Every readable `package.json` under the globs, outside `node_modules`, by directory. */
function findWorkspaces(
	root: string,
	globs: readonly string[],
): WorkspaceManifest[] {
	const found = new Map<string, WorkspaceManifest>();
	for (const glob of globs) {
		const pattern = `${glob.replace(/\/+$/, "")}/package.json`;
		for (const path of new Bun.Glob(pattern).scanSync({
			cwd: root,
			onlyFiles: true,
		})) {
			if (path.includes("node_modules")) continue;
			const dir = path.slice(0, -"/package.json".length);
			try {
				found.set(dir, {
					dir,
					pkg: JSON.parse(readFileSync(join(root, path), "utf8")),
				});
			} catch {
				// Not a readable manifest; nothing to run.
			}
		}
	}
	return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/** A directory name as an app key: `@x/foo.bar` → `foo-bar`. */
function appName(dir: string): string {
	const name = basename(dir).replace(/[^A-Za-z0-9_-]/g, "-");
	return /^[A-Za-z]/.test(name) ? name : `app-${name}`;
}

/**
 * Apps for every workspace matching `globs` that defines `script`.
 *
 * ```ts
 * apps: {
 *   ...discoverApps({ globs: ["apps/extension-*", "extensions/*"], prebuild: "build" }),
 * }
 * ```
 *
 * Read when the config is evaluated, so a new workspace needs no config edit.
 * App keys are directory names; two workspaces with the same name are an
 * error rather than one silently replacing the other.
 */
export function discoverApps(
	options: DiscoverAppsOptions,
): Record<string, AppConfig> {
	const root = options.root ?? findMonorepoRoot();
	const script = options.script ?? "dev";
	const kind = options.kind ?? "worker";
	if (kind === "server" && options.port === undefined) {
		throw new Error("discoverApps: servers need a base `port`");
	}

	const apps: Record<string, AppConfig> = {};
	const dirs = new Map<string, string>();
	let nextPort = options.port ?? 0;

	for (const workspace of findWorkspaces(root, options.globs)) {
		const scripts = workspace.pkg.scripts ?? {};
		if (!scripts[script]) continue;
		const name = appName(workspace.dir);
		const clash = dirs.get(name);
		if (clash) {
			throw new Error(
				`discoverApps: ${clash} and ${workspace.dir} both become app "${name}"; rename one directory`,
			);
		}
		dirs.set(name, workspace.dir);

		const shared = {
			...options.app,
			devCommand: `bun run ${script}`,
			cwd: workspace.dir,
			...(options.prebuild && scripts[options.prebuild]
				? { prebuild: `bun run ${options.prebuild}` }
				: {}),
			...(scripts.build ? { buildCommand: "bun run build" } : {}),
		};
		// `options.app` is typed against both kinds; validation catches a field
		// the chosen kind cannot take (a worker with a health endpoint).
		const app = (
			kind === "server"
				? { ...shared, port: nextPort++ }
				: { ...shared, kind: "worker" }
		) as AppConfig;
		Object.defineProperty(app, DISCOVERED_APP, {
			value: true,
			enumerable: true,
		});
		apps[name] = app;
	}
	return apps;
}

export function isDiscoveredApp(app: AppConfig | undefined): boolean {
	return Boolean(app && (app as { [DISCOVERED_APP]?: true })[DISCOVERED_APP]);
}
