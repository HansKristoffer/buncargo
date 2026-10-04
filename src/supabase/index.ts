import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_HTTP_SERVICE_NAMES } from "../core/hosts/plan";
import { externalStackProjectName, findMonorepoRoot } from "../core/ports";
import { configuredPrimaryApp, resolvePrimaryApp } from "../core/primary-app";
import { isCI } from "../core/runtime-flags";
import { shellQuote } from "../core/shell-quote";
import { formatDone, formatStep } from "../core/style";
import { writeIfChanged } from "../environment/generated-files";
import type {
	AppConfig,
	BuncargoIntegration,
	EnvValues,
	EnvVarsContext,
	HostsOptionsLike,
	IntegrationConfig,
	ServiceConfig,
} from "../types";
import { supabaseChecks } from "./checks";
import { resolveSupabaseBin } from "./cli";
import { supabaseKeys } from "./keys";
import { readSupabaseProject, type SupabaseProject } from "./project";

/**
 * `buncargo/supabase`: the Supabase CLI's local stack, one per checkout.
 *
 * ```ts
 * import { supabase } from "buncargo/supabase";
 * integrations: [supabase({ publicEnvPrefix: "VITE_" })]
 * ```
 *
 * The CLI keeps running the stack; buncargo gives it this checkout's project
 * id and ports through `SUPABASE_*` env overrides (the CLI reads every
 * `config.toml` key from one), points auth at this checkout's apps, and hands
 * the URLs and keys to every app. Nothing rewrites `config.toml`.
 */

export {
	SUPABASE_DEFAULT_JWT_SECRET,
	SUPABASE_PUBLISHABLE_KEY,
	SUPABASE_SECRET_KEY,
	type SupabaseKeys,
	signSupabaseKey,
	supabaseKeys,
} from "./keys";
export {
	parseSupabaseConfig,
	readSupabaseProject,
	SUPABASE_DEFAULT_PORTS,
	type SupabaseProject,
} from "./project";

declare module "../types/all-types" {
	interface IntegrationAppNames {
		supabaseFunctions: true;
	}
}

/** The service keys the integration adds; `supabase` is the API apps call. */
export const SUPABASE_SERVICES = {
	api: "supabase",
	db: "supabaseDb",
	studio: "supabaseStudio",
	mail: "supabaseMail",
} as const;

const STACK = "supabase";

/** `-x` defaults in CI: tooling for people, which a test run never opens. */
const CI_EXCLUDE = ["studio", "postgres-meta", "logflare", "vector"];

export interface SupabaseIntegrationOptions {
	/** The directory holding `supabase/`, relative to the monorepo root. Default: the root */
	workdir?: string;
	/**
	 * Prefixes for browser copies of `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
	 * `SUPABASE_PUBLISHABLE_KEY`: `"VITE_"`, `"NEXT_PUBLIC_"`, `["VITE_", "EXPO_PUBLIC_"]`.
	 */
	publicEnvPrefix?: string | readonly string[];
	/**
	 * The app auth sends people back to (`auth.site_url`). Default: the primary
	 * app. `false` keeps `config.toml`'s, and its redirect list.
	 */
	siteUrlApp?: string | false;
	/**
	 * Containers `supabase start` skips (`-x`), e.g. `["studio", "imgproxy"]`.
	 * Default: none, and Studio, pg-meta and analytics in CI.
	 */
	exclude?: readonly string[];
	/** Apply new migrations (`supabase migration up`) on every start. Default: true */
	migrate?: boolean;
	/**
	 * Regenerate TypeScript types after migrations, when the migrations
	 * changed or the file is missing.
	 */
	types?: { output: string; schemas?: readonly string[] };
	/** Run `supabase functions serve` as the `supabaseFunctions` worker. Default: false */
	functions?: boolean;
}

/** Every origin auth may redirect to: each app's current, loopback and public URL. */
function redirectUrls(
	appNames: readonly string[],
	urls: Record<string, string>,
	ctx: { loopbackUrls: unknown; publicUrls: unknown },
	configured: readonly string[],
): string[] {
	const loopback = ctx.loopbackUrls as Record<string, string>;
	const publicUrls = ctx.publicUrls as Record<string, string>;
	const origins = appNames.flatMap((name) =>
		[urls[name], loopback[name], publicUrls[name]].filter(
			(url): url is string => url !== undefined,
		),
	);
	return [
		...new Set([
			...configured,
			...origins.flatMap((origin) => [origin, `${origin}/**`]),
		]),
	];
}

/** The container each optional service is served by, as `supabase start -x` names it. */
const SERVICE_CONTAINERS = { api: "kong", studio: "studio", mail: "mailpit" };

function supabaseServices(
	project: SupabaseProject,
	exclude: readonly string[],
): Record<string, ServiceConfig> {
	const external = { stack: STACK };
	const runs = (component: keyof typeof SERVICE_CONTAINERS) =>
		project[component].enabled &&
		!exclude.includes(SERVICE_CONTAINERS[component]);
	return {
		...(runs("api")
			? {
					[SUPABASE_SERVICES.api]: {
						port: project.api.port,
						external,
						exposeProtocol: "http",
					},
				}
			: {}),
		[SUPABASE_SERVICES.db]: {
			port: project.db.port,
			external: { ...external, preset: "postgres" },
			exposeProtocol: "tcp",
			urlTemplate: ({ host, port }) =>
				`postgresql://postgres:postgres@${host}:${port}/postgres`,
		},
		...(runs("studio")
			? {
					[SUPABASE_SERVICES.studio]: {
						port: project.studio.port,
						external,
						exposeProtocol: "http",
					},
				}
			: {}),
		...(runs("mail")
			? {
					[SUPABASE_SERVICES.mail]: {
						port: project.mail.port,
						external,
						exposeProtocol: "http",
					},
				}
			: {}),
	};
}

/** Name Supabase's web UIs on `hosts`, unless the config lists its own. */
function withNamedServices(
	hosts: boolean | HostsOptionsLike | undefined,
	names: readonly string[],
): boolean | HostsOptionsLike | undefined {
	if (!hosts) return hosts;
	const base = hosts === true ? {} : hosts;
	if (base.services) return hosts;
	return { ...base, services: [...DEFAULT_HTTP_SERVICE_NAMES, ...names] };
}

/** Changes whenever the generated types could: migrations, schemas, options. */
function typesFingerprint(workdir: string, schemas: readonly string[]): string {
	const hash = createHash("sha256").update(JSON.stringify(schemas));
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else hash.update(relative(workdir, path)).update(readFileSync(path));
		}
	};
	walk(join(workdir, "supabase", "migrations"));
	walk(join(workdir, "supabase", "schemas"));
	return hash.digest("hex");
}

export function supabase(
	options: SupabaseIntegrationOptions = {},
): BuncargoIntegration {
	const workdirOption = options.workdir;
	const workdirOf = (root: string) => resolve(root, workdirOption ?? ".");
	// Set in `config()`, which runs before anything below is called.
	let project: SupabaseProject | undefined;
	let bin = "supabase";
	let exclude: readonly string[] = [];

	return {
		name: "supabase",

		config(config) {
			const root = findMonorepoRoot();
			const toml = readSupabaseProject(workdirOf(root));
			project = toml;
			bin = resolveSupabaseBin(root);
			exclude = options.exclude ?? (isCI() ? CI_EXCLUDE : []);

			const services = supabaseServices(toml, exclude);
			const apps: Record<string, AppConfig> = { ...(config.apps ?? {}) };
			const siteApp =
				options.siteUrlApp === false
					? undefined
					: (options.siteUrlApp ??
						configuredPrimaryApp(config.options) ??
						resolvePrimaryApp({ apps, options: config.options }));
			if (siteApp && !apps[siteApp]) {
				throw new Error(`supabase(): "${siteApp}" is not a configured app`);
			}
			const serverApps = Object.entries(apps)
				.filter(([, app]) => app.kind !== "worker")
				.map(([name]) => name);

			if (options.functions) {
				apps.supabaseFunctions ??= {
					kind: "worker",
					devCommand: `${shellQuote(bin)} functions serve`,
					cwd: workdirOption,
					essential: false,
					requiredServices: [SUPABASE_SERVICES.api],
				};
			}

			const prefixes =
				typeof options.publicEnvPrefix === "string"
					? [options.publicEnvPrefix]
					: (options.publicEnvPrefix ?? []);
			const keys = supabaseKeys(toml.auth.jwtSecret);
			const userEnv = config.env;

			const supabaseEnv = (
				ports: Record<string, number>,
				urls: Record<string, string>,
				ctx: EnvVarsContext<
					Record<string, ServiceConfig>,
					Record<string, AppConfig>
				>,
			): EnvValues => {
				const offset = ctx.portOffset;
				const apiUrl = urls[SUPABASE_SERVICES.api];
				const browser: Record<string, string> = apiUrl
					? {
							SUPABASE_URL: apiUrl,
							SUPABASE_ANON_KEY: keys.anonKey,
							SUPABASE_PUBLISHABLE_KEY: keys.publishableKey,
						}
					: {};
				const siteUrl = siteApp ? urls[siteApp] : undefined;
				return {
					// What the CLI reads in place of `config.toml`.
					SUPABASE_PROJECT_ID: externalStackProjectName(ctx.projectName),
					SUPABASE_API_PORT: ports[SUPABASE_SERVICES.api],
					SUPABASE_DB_PORT: ports[SUPABASE_SERVICES.db],
					SUPABASE_STUDIO_PORT: ports[SUPABASE_SERVICES.studio],
					SUPABASE_LOCAL_SMTP_PORT: ports[SUPABASE_SERVICES.mail],
					// Ports nobody opens by hand still have to differ per worktree.
					SUPABASE_DB_SHADOW_PORT: toml.db.shadowPort + offset,
					SUPABASE_DB_POOLER_PORT: toml.db.pooler.port + offset,
					SUPABASE_ANALYTICS_PORT: toml.analytics.port + offset,
					SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT:
						toml.edgeRuntime.inspectorPort + offset,
					...(siteUrl
						? {
								SUPABASE_AUTH_SITE_URL: siteUrl,
								SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS: redirectUrls(
									serverApps,
									urls,
									ctx,
									toml.auth.additionalRedirectUrls,
								).join(","),
							}
						: {}),
					// What apps read.
					...browser,
					SUPABASE_SERVICE_ROLE_KEY: keys.serviceRoleKey,
					SUPABASE_SECRET_KEY: keys.secretKey,
					SUPABASE_DB_URL: urls[SUPABASE_SERVICES.db],
					...Object.fromEntries(
						prefixes.flatMap((prefix) =>
							Object.entries(browser).map(([name, value]) => [
								`${prefix}${name}`,
								value,
							]),
						),
					),
				};
			};

			return {
				...config,
				// Anything the config defines itself wins.
				services: { ...services, ...config.services },
				apps,
				migrations:
					options.migrate === false
						? config.migrations
						: [
								{
									name: "supabase",
									command: `${shellQuote(bin)} migration up --local`,
									cwd: workdirOption,
									requiredServices: [SUPABASE_SERVICES.db],
									secrets: false,
								},
								...(config.migrations ?? []),
							],
				env: (ports, urls, ctx) => ({
					...supabaseEnv(
						ports as Record<string, number>,
						urls as Record<string, string>,
						ctx,
					),
					...userEnv?.(ports, urls, ctx),
				}),
				options: {
					...config.options,
					hosts: withNamedServices(
						config.options?.hosts,
						[
							SUPABASE_SERVICES.api,
							SUPABASE_SERVICES.studio,
							SUPABASE_SERVICES.mail,
						].filter((name) => services[name]),
					),
				},
			} as IntegrationConfig;
		},

		stacks: {
			[STACK]: {
				async up(ctx) {
					console.log(formatStep("⚡ Starting Supabase..."));
					await ctx.exec(
						[
							bin,
							"start",
							...(exclude.length > 0 ? ["-x", exclude.join(",")] : []),
						],
						{ cwd: workdirOption, signal: ctx.signal },
					);
					console.log(formatDone("Supabase ready"));
				},
				down: ({ projectName, removeVolumes }) => [
					bin,
					"stop",
					"--project-id",
					externalStackProjectName(projectName),
					...(removeVolumes ? ["--no-backup"] : []),
				],
			},
		},

		hooks: {
			// After migrations, so the types describe the schema just applied.
			async afterContainersReady(ctx) {
				const types = options.types;
				if (!types || !ctx.selectedServices?.includes(SUPABASE_SERVICES.db))
					return;
				const workdir = workdirOf(ctx.root);
				const output = resolve(ctx.root, types.output);
				const stamp = join(ctx.root, ".buncargo", "supabase-types.json");
				const schemas = types.schemas ?? [];
				const fingerprint = typesFingerprint(workdir, schemas);
				const recorded = existsSync(stamp)
					? (JSON.parse(readFileSync(stamp, "utf8")) as { output?: string })
					: {};
				if (existsSync(output) && recorded.output === fingerprint) return;

				const { stdout } = await ctx.exec(
					[
						bin,
						"gen",
						"types",
						"typescript",
						"--local",
						...schemas.flatMap((schema) => ["--schema", schema]),
					],
					{ cwd: workdirOption, secrets: false, signal: ctx.signal },
				);
				if (writeIfChanged(output, stdout))
					console.log(formatDone(`Generated ${relative(ctx.root, output)}`));
				writeIfChanged(stamp, JSON.stringify({ output: fingerprint }));
			},
		},

		checks: supabaseChecks({
			project: (root) => {
				project ??= readSupabaseProject(workdirOf(root));
				return project;
			},
			workdir: workdirOf,
		}),

		describe: (ctx) => {
			const urls = ctx.urls as Record<string, string>;
			const rows: Record<string, string> = {};
			const studio = urls[SUPABASE_SERVICES.studio];
			const mail = urls[SUPABASE_SERVICES.mail];
			if (studio) rows["Supabase Studio"] = studio;
			if (mail) rows["Supabase mail"] = mail;
			return rows;
		},
	};
}
