import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The parts of `supabase/config.toml` the integration needs: which components
 * run and on which base ports, and the auth settings it extends per worktree.
 */
export interface SupabaseProject {
	/** Absolute path of the toml, whether or not it exists. */
	path: string;
	exists: boolean;
	/** Why an existing toml could not be read; its defaults are used meanwhile. */
	error?: string;
	projectId?: string;
	api: { enabled: boolean; port: number };
	db: {
		port: number;
		shadowPort: number;
		pooler: { enabled: boolean; port: number };
	};
	studio: { enabled: boolean; port: number };
	/** `[local_smtp]`, or the deprecated `[inbucket]` the CLI still reads. */
	mail: { enabled: boolean; port: number };
	analytics: { enabled: boolean; port: number };
	edgeRuntime: { enabled: boolean; inspectorPort: number };
	auth: {
		/** Absent means the CLI's well-known default, and its fixed demo keys. */
		jwtSecret?: string;
		additionalRedirectUrls: string[];
	};
}

/** `supabase init`'s ports, which the CLI also falls back to. */
export const SUPABASE_DEFAULT_PORTS = {
	api: 54321,
	db: 54322,
	shadow: 54320,
	pooler: 54329,
	studio: 54323,
	mail: 54324,
	analytics: 54327,
	inspector: 8083,
} as const;

type Table = Record<string, unknown>;

function table(value: unknown): Table {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Table)
		: {};
}

function port(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

function enabled(section: Table, fallback = true): boolean {
	return typeof section.enabled === "boolean" ? section.enabled : fallback;
}

/** Parse a `config.toml`. Throws on invalid TOML; missing keys take the CLI's defaults. */
export function parseSupabaseConfig(
	text: string,
	path: string,
): SupabaseProject {
	const raw = Bun.TOML.parse(text) as Table;
	const api = table(raw.api);
	const db = table(raw.db);
	const pooler = table(db.pooler);
	const studio = table(raw.studio);
	const mail = table(raw.local_smtp ?? raw.inbucket);
	const analytics = table(raw.analytics);
	const edgeRuntime = table(raw.edge_runtime);
	const auth = table(raw.auth);
	const defaults = SUPABASE_DEFAULT_PORTS;

	return {
		path,
		exists: true,
		projectId: typeof raw.project_id === "string" ? raw.project_id : undefined,
		api: { enabled: enabled(api), port: port(api.port, defaults.api) },
		db: {
			port: port(db.port, defaults.db),
			shadowPort: port(db.shadow_port, defaults.shadow),
			pooler: {
				enabled: enabled(pooler, false),
				port: port(pooler.port, defaults.pooler),
			},
		},
		studio: {
			enabled: enabled(studio),
			port: port(studio.port, defaults.studio),
		},
		mail: { enabled: enabled(mail), port: port(mail.port, defaults.mail) },
		analytics: {
			enabled: enabled(analytics),
			port: port(analytics.port, defaults.analytics),
		},
		edgeRuntime: {
			enabled: enabled(edgeRuntime),
			inspectorPort: port(edgeRuntime.inspector_port, defaults.inspector),
		},
		auth: {
			jwtSecret:
				typeof auth.jwt_secret === "string" && auth.jwt_secret.length > 0
					? auth.jwt_secret
					: undefined,
			additionalRedirectUrls: Array.isArray(auth.additional_redirect_urls)
				? auth.additional_redirect_urls.filter(
						(url): url is string => typeof url === "string",
					)
				: [],
		},
	};
}

/**
 * Read `<workdir>/supabase/config.toml`, leniently: without one (CI, a fresh
 * clone), or with one that does not parse, every component takes the CLI's
 * defaults and a check reports it, rather than every command failing.
 */
export function readSupabaseProject(workdir: string): SupabaseProject {
	const path = join(workdir, "supabase", "config.toml");
	if (!existsSync(path)) {
		return { ...parseSupabaseConfig("", path), exists: false };
	}
	try {
		return parseSupabaseConfig(readFileSync(path, "utf8"), path);
	} catch (error) {
		return {
			...parseSupabaseConfig("", path),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
