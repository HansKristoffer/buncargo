import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { AppConfig, ServiceConfig } from "../types";

// ═══════════════════════════════════════════════════════════════════════════
// Monorepo Root Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the monorepo root by looking for package.json with workspaces.
 */
export function findMonorepoRoot(startDir?: string): string {
	let dir = startDir ?? process.cwd();
	while (dir !== "/") {
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
		dir = dirname(dir);
	}
	return process.cwd();
}

// ═══════════════════════════════════════════════════════════════════════════
// Worktree Detection
// ═══════════════════════════════════════════════════════════════════════════

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
 * Check if the current directory is a git worktree.
 */
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
	if (!worktreeName) return null;
	const sanitized = sanitizeProjectSuffix(worktreeName);
	return sanitized || "worktree";
}

// ═══════════════════════════════════════════════════════════════════════════
// Project Naming
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate Docker project name from prefix and directory.
 */
export function getProjectName(
	prefix: string,
	suffix?: string,
	root?: string,
): string {
	const monorepoRoot = root ?? findMonorepoRoot();
	const dirName = basename(monorepoRoot);
	const baseName = `${prefix}-${dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
	return suffix ? `${baseName}-${suffix}` : baseName;
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
	const worktree = isWorktree(root);
	const worktreeSuffix =
		worktree && worktreeIsolation ? getWorktreeProjectSuffix(root) : null;
	const projectSuffix =
		[suffix, worktreeSuffix].filter(Boolean).join("-") || undefined;
	const projectName = getProjectName(projectPrefix, projectSuffix, root);

	return {
		worktree,
		worktreeSuffix,
		projectSuffix,
		projectName,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// URL Generation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Service defaults for common services.
 */
const SERVICE_DEFAULTS: Record<
	string,
	{ user: string; password: string; database: string }
> = {
	postgres: { user: "postgres", password: "postgres", database: "postgres" },
	postgresql: { user: "postgres", password: "postgres", database: "postgres" },
	redis: { user: "", password: "", database: "" },
	clickhouse: { user: "default", password: "clickhouse", database: "default" },
	mysql: { user: "root", password: "root", database: "mysql" },
	mongodb: { user: "", password: "", database: "" },
};

/**
 * Build URL for a service with given credentials and database.
 */
function buildServiceUrl(
	serviceName: string,
	ctx: { port: number; host: string },
	config: { database?: string; user?: string; password?: string },
): string | null {
	const defaults = SERVICE_DEFAULTS[serviceName];
	if (!defaults && !config.database) return null;

	const user = config.user ?? defaults?.user ?? "";
	const password = config.password ?? defaults?.password ?? "";
	const database = config.database ?? defaults?.database ?? "";

	switch (serviceName) {
		case "postgres":
		case "postgresql":
			return `postgresql://${user}:${password}@${ctx.host}:${ctx.port}/${database}`;
		case "redis":
			return `redis://${ctx.host}:${ctx.port}`;
		case "clickhouse":
			return `http://${user}:${password}@${ctx.host}:${ctx.port}/${database}`;
		case "mysql":
			return `mysql://${user}:${password}@${ctx.host}:${ctx.port}/${database}`;
		case "mongodb":
			return database
				? `mongodb://${ctx.host}:${ctx.port}/${database}`
				: `mongodb://${ctx.host}:${ctx.port}`;
		default:
			return null;
	}
}

/**
 * Compute the localhost/local-IP URLs for all services and apps.
 *
 * Named-host (`https://<name>.<project>.localhost`) rewriting is layered on top
 * by callers via `applyHostPlanToUrls`, so this module stays independent of the
 * hosts subsystem.
 */
export function computeUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	services: TServices,
	apps: TApps | undefined,
	ports: Record<string, number>,
	localIp: string,
): Record<string, string> {
	const urls: Record<string, string> = {};
	const host = "localhost";

	// Add service URLs
	for (const [name, config] of Object.entries(services)) {
		const port = ports[name];
		const secondaryPort = ports[`${name}Secondary`];

		// Skip if port is not defined
		if (port === undefined) continue;

		const ctx = { port, secondaryPort, host, localIp };

		if (config.urlTemplate) {
			// Use the provided function
			urls[name] = config.urlTemplate(ctx);
		} else {
			// Try to build URL using service name and config options
			const builtUrl = buildServiceUrl(
				name,
				{ port, host },
				{
					database: config.database,
					user: config.user,
					password: config.password,
				},
			);
			if (builtUrl) {
				urls[name] = builtUrl;
			} else {
				// Fallback to simple HTTP URL
				urls[name] = `http://${host}:${port}`;
			}
		}
	}

	// Add app URLs
	if (apps) {
		for (const [name, _config] of Object.entries(apps)) {
			const port = ports[name];
			urls[name] = `http://${host}:${port}`;
			// Also add local IP version for mobile connectivity
			urls[`${name}Local`] = `http://${localIp}:${port}`;
		}
	}

	return urls;
}
