import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
	AppConfig,
	ComputedLoopbackUrls,
	ComputedPorts,
	ComputedUrls,
	ResolvedService,
	ServiceConfig,
} from "../types";

/**
 * Ports keyed by an unknown set of names.
 *
 * `ComputedPorts` is an intersection of mapped types with no index signature,
 * which is what makes `ports.typo` an error, so it cannot flow into helpers that
 * legitimately work over unknown keys. `PortMap` is that untyped shape, and
 * {@link toPortMap} / {@link asComputedPorts} are the only two places the
 * conversion happens.
 */
export type PortMap = Record<string, number>;

/** URLs keyed by an unknown set of names. See {@link PortMap}. */
export type UrlMap = Record<string, string>;

/**
 * Widen a config-keyed port record so key-agnostic helpers can read it.
 *
 * The constraint accepts any record whose values are all numbers, which every
 * `ComputedPorts` instantiation satisfies. The result aliases `ports`, so
 * helpers that mutate the map mutate the caller's record.
 */
export function toPortMap<T extends Record<keyof T, number>>(
	ports: T,
): PortMap {
	return ports as PortMap;
}

/** Widen a config-keyed URL record. See {@link toPortMap}. */
export function toUrlMap<T extends Record<keyof T, string>>(urls: T): UrlMap {
	return urls as UrlMap;
}

/**
 * Key a {@link PortMap} on a config's services and apps.
 *
 * The allocator builds ports by iterating the config at runtime, so the
 * keys it produces are only known to the type system through the config that
 * was passed in. This is the single place that correspondence is asserted.
 */
export function asComputedPorts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(ports: PortMap): ComputedPorts<TServices, TApps> {
	return ports as ComputedPorts<TServices, TApps>;
}

/** Key a {@link UrlMap} on a config's services and apps. See {@link asComputedPorts}. */
export function asComputedUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(urls: UrlMap): ComputedUrls<TServices, TApps> {
	return urls as ComputedUrls<TServices, TApps>;
}

/** Key a loopback {@link UrlMap}. See {@link asComputedPorts}. */
export function asComputedLoopbackUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(urls: UrlMap): ComputedLoopbackUrls<TServices, TApps> {
	return urls as ComputedLoopbackUrls<TServices, TApps>;
}

/**
 * The nearest repository/monorepo root above `startDir`, or `startDir` itself.
 *
 * Prefers a `package.json` with `workspaces`, then a directory containing
 * `dev.config.ts` / `dev.config.js` (so rootless multi-package repos resolve
 * from subdirectories even when a package has its own `pnpm-workspace.yaml`),
 * then `pnpm-workspace.yaml`.
 */
export function findMonorepoRoot(startDir?: string): string {
	const initial = resolve(startDir ?? process.cwd());
	let dir = initial;
	let configDir: string | undefined;
	let pnpmDir: string | undefined;
	for (;;) {
		try {
			const pkgPath = resolve(dir, "package.json");
			if (existsSync(pkgPath)) {
				const content = readFileSync(pkgPath, "utf-8");
				const pkg = JSON.parse(content);
				if (pkg.workspaces) {
					return dir;
				}
			}
		} catch {
			// Continue searching
		}
		if (
			configDir === undefined &&
			(existsSync(resolve(dir, "dev.config.ts")) ||
				existsSync(resolve(dir, "dev.config.js")))
		) {
			configDir = dir;
		}
		if (
			pnpmDir === undefined &&
			existsSync(resolve(dir, "pnpm-workspace.yaml"))
		) {
			pnpmDir = dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return configDir ?? pnpmDir ?? initial;
		dir = parent;
	}
}

/**
 * Get the worktree name from .git file (if in a worktree).
 */
export function getWorktreeName(root?: string): string | null {
	const monorepoRoot = root ?? findMonorepoRoot();
	const gitPath = resolve(monorepoRoot, ".git");
	try {
		if (!existsSync(gitPath) || !statSync(gitPath).isFile()) return null;
		const content = readFileSync(gitPath, "utf-8").trim();
		const match = content.match(/^gitdir:\s*(.+)$/);
		if (!match?.[1]) return null;
		return basename(match[1]);
	} catch {
		return null;
	}
}

/**
 * The Git worktree a root sits below, when the root is not its top level.
 *
 * {@link getWorktreeName} reads only the root's own `.git`, so a config in a
 * subdirectory of a worktree gets no worktree name in its project name. That
 * cannot change without renaming every such checkout's existing stack and
 * volume; this only lets an error say why two checkouts share a name.
 */
export function enclosingWorktreeName(root: string): string | null {
	if (existsSync(resolve(root, ".git"))) return null;
	let dir = dirname(resolve(root));
	for (;;) {
		if (existsSync(resolve(dir, ".git"))) return getWorktreeName(dir);
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Whether the checkout at `root` is a Git worktree. */
export function isWorktree(root?: string): boolean {
	return getWorktreeName(root) !== null;
}

/**
 * Sanitize a string for use as a Docker Compose project suffix.
 */
function sanitizeProjectSuffix(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Get a sanitized worktree-derived suffix for Docker project isolation.
 * Returns null when not running in a worktree.
 */
export function getWorktreeProjectSuffix(root?: string): string | null {
	const worktreeName = getWorktreeName(root);
	return worktreeName ? worktreeProjectSuffix(worktreeName) : null;
}

/** A worktree name as it appears in a project name. */
export function worktreeProjectSuffix(worktreeName: string): string {
	return sanitizeProjectSuffix(worktreeName) || "worktree";
}

/**
 * Generate Docker project name from prefix and directory.
 */
export function getProjectName(
	prefix: string,
	suffix?: string,
	root?: string,
): string {
	const baseName = `${prefix}-${directorySegment(root ?? findMonorepoRoot())}`;
	return suffix ? `${baseName}-${suffix}` : baseName;
}

/** The checkout directory as it appears in a project name. */
function directorySegment(root: string): string {
	return basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-");
}

/** The longest project id the Supabase CLI keeps; it cuts anything longer. */
const EXTERNAL_STACK_NAME_MAX = 40;

/**
 * The project name an integration's stack runs under.
 *
 * The project name itself when it fits, so the stack's containers carry the
 * same Compose project label as ours and their ports read as this run's.
 * Worktree names make it long, and a CLI that silently truncates would label
 * its containers with a name we never compare against, so anything longer is
 * shortened here, the same way for every caller, and keeps a hash of the whole.
 */
export function externalStackProjectName(projectName: string): string {
	if (projectName.length <= EXTERNAL_STACK_NAME_MAX) return projectName;
	const hash = createHash("sha256")
		.update(projectName)
		.digest("hex")
		.slice(0, 8);
	return `${projectName.slice(0, EXTERNAL_STACK_NAME_MAX - 9)}-${hash}`;
}

export interface DevIdentityOptions {
	projectPrefix: string;
	suffix?: string;
	root?: string;
	worktreeIsolation?: boolean;
}

export interface DevIdentity {
	worktree: boolean;
	worktreeSuffix: string | null;
	projectSuffix?: string;
	projectName: string;
}

/** The suffix `buncargo ci` runs its own stack under. */
export const CI_PROJECT_SUFFIX = "ci";

/** A project name from its parts; the one place the order is decided. */
function identityProjectName(
	projectPrefix: string,
	root: string,
	suffix: string | undefined,
	worktreeSuffix: string | null,
) {
	// The directory name is already in the project name, and a worktree's
	// directory is normally named after it: only a worktree whose directory
	// says something else still needs its name added.
	const nameSuffix =
		worktreeSuffix && worktreeSuffix !== directorySegment(root)
			? worktreeSuffix
			: null;
	const projectSuffix =
		[suffix, nameSuffix].filter(Boolean).join("-") || undefined;
	return {
		projectSuffix,
		projectName: getProjectName(projectPrefix, projectSuffix, root),
	};
}

/**
 * Compute all identity values used by the dev environment in one place.
 */
export function computeDevIdentity(options: DevIdentityOptions): DevIdentity {
	const {
		projectPrefix,
		suffix,
		root: providedRoot,
		worktreeIsolation = true,
	} = options;
	const root = providedRoot ?? findMonorepoRoot();
	const worktreeName = getWorktreeName(root);
	const worktree = worktreeName !== null;
	const worktreeSuffix =
		worktreeName !== null && worktreeIsolation
			? worktreeProjectSuffix(worktreeName)
			: null;
	return {
		worktree,
		worktreeSuffix,
		...identityProjectName(projectPrefix, root, suffix, worktreeSuffix),
	};
}

export interface CheckoutProjectNamesOptions {
	projectPrefix: string;
	/** The checkout's root. Default: the monorepo root above the working directory. */
	root?: string;
	/**
	 * The checkout's Git worktree name (the directory under `.git/worktrees`),
	 * or null for the main checkout. Read from the root's `.git` when left
	 * out; pass it for a worktree whose directory is already gone.
	 */
	worktree?: string | null;
	/** `options.worktreeIsolation` from the config. Default: true. */
	worktreeIsolation?: boolean;
}

/** The Compose project names a checkout's stacks run under. */
export interface CheckoutProjectNames {
	/** `buncargo dev`, `dev.start()` and every command that reuses them. */
	dev: string;
	/**
	 * The stack `buncargo ci` ran under before each run got its own
	 * (`<ci>-<id>[-<runner>]`, on tmpfs), which a checkout may still hold.
	 */
	ci: string;
}

/**
 * The project names buncargo gives a checkout's stacks, for tools that find
 * or clean up a checkout's containers and volumes without loading its config.
 */
export function checkoutProjectNames(
	options: CheckoutProjectNamesOptions,
): CheckoutProjectNames {
	const root = options.root ?? findMonorepoRoot();
	const worktree =
		options.worktree === undefined ? getWorktreeName(root) : options.worktree;
	const worktreeSuffix =
		worktree !== null && options.worktreeIsolation !== false
			? worktreeProjectSuffix(worktree)
			: null;
	const name = (suffix?: string) =>
		identityProjectName(options.projectPrefix, root, suffix, worktreeSuffix)
			.projectName;
	return { dev: name(), ci: name(CI_PROJECT_SUFFIX) };
}

/**
 * The environment variable stem for a service or app key: `my-db` becomes
 * `MY_DB`, so `MY_DB_PORT` and `MY_DB_URL`. A hyphen is no part of a name
 * Compose or a shell can read, and `${MY-DB_PORT:-5432}` reads to Compose as
 * the variable `MY` with a default. Validation rejects two keys with one stem.
 */
export function envName(key: string): string {
	return key.toUpperCase().replaceAll("-", "_");
}

/**
 * Where a client dials an app that listens on `host` (`apps.<name>.host`), as
 * a URL authority: the address itself when it is one, bracketed for IPv6, so
 * `localhost` never resolves to a family the app did not bind. Undefined for
 * a wildcard bind (or none), which every loopback address reaches.
 */
export function appDialAuthority(host: string | undefined): string | undefined {
	if (!host || host === "0.0.0.0" || host === "::" || host === "localhost") {
		return undefined;
	}
	return host.includes(":") ? `[${host}]` : host;
}

/**
 * Compute the localhost/local-IP URLs for all services and apps.
 *
 * Named-host (`https://<name>.<project>.localhost`) rewriting is layered on top
 * by callers via `applyHostPlanToUrls`, so this module stays independent of the
 * hosts subsystem.
 */
export function computeUrls(
	services: Readonly<Record<string, ResolvedService>>,
	apps: Readonly<Record<string, { port?: number; host?: string }>>,
	ports: PortMap,
	localIp: string,
	/** Host for app URLs (`BUNCARGO_URL_HOST`); services always use `localhost`. */
	appHost?: string,
): UrlMap {
	const urls: UrlMap = {};
	const host = "localhost";

	for (const [name, service] of Object.entries(services)) {
		const port = ports[name];
		if (port === undefined || service.port === undefined) continue;
		const secondaryPort = ports[`${name}Secondary`];
		urls[name] = service.url({ port, secondaryPort, host, localIp });
	}

	for (const [name, app] of Object.entries(apps)) {
		const port = ports[name];
		if (port === undefined || app.port === undefined) continue;
		// An app bound to one address is reached there, whatever the URL host.
		const bound = appDialAuthority(app.host);
		urls[name] = `http://${bound ?? appHost ?? host}:${port}`;
		// Also add local IP version for mobile connectivity
		urls[`${name}Local`] = `http://${localIp}:${port}`;
	}

	return urls;
}

/**
 * The loopback subset of {@link computeUrls}, kept for consumers that cannot
 * follow a named-host rewrite.
 *
 * `applyHostPlanToUrls` overwrites the main URL map in place, so a caller that
 * needs the reachable-without-a-CA address has nothing left to read otherwise.
 * The `<app>Local` LAN aliases are dropped: they are a different address.
 */
export function computeLoopbackUrls(
	services: Readonly<Record<string, ResolvedService>>,
	apps: Readonly<Record<string, { port?: number; host?: string }>>,
	ports: PortMap,
): UrlMap {
	const loopback: UrlMap = {};
	const host = "localhost";

	for (const [name, service] of Object.entries(services)) {
		const port = ports[name];
		if (port === undefined || service.port === undefined) continue;
		const secondaryPort = ports[`${name}Secondary`];
		loopback[name] = service.url({
			port,
			secondaryPort,
			host,
			localIp: "127.0.0.1",
		});
	}

	for (const [name, app] of Object.entries(apps)) {
		const port = ports[name];
		if (port === undefined || app.port === undefined) continue;
		const bound = appDialAuthority(app.host);
		loopback[name] = `http://${bound ?? host}:${port}`;
	}

	return loopback;
}
