import { describe, expect, it } from "bun:test";
import { defineDevConfig, mergeConfigs } from "../config";
import { getEnvVar } from "../core/utils";
import { service } from "../docker-compose/services";
import { createDevEnvironment } from "../environment";
import { firebase } from "../firebase";
import { shopify } from "../shopify";
import { supabase } from "../supabase";
import type {
	AnyDevConfig,
	AnyDevEnvironment,
	AppConfig,
	ComputedEnvVars,
	ComputedPorts,
	EnvValues,
	PrismaConfig,
	ServiceConfig,
	TypedAppDefinitions,
} from ".";

// ═══════════════════════════════════════════════════════════════════════════
// Type-level guardrails
// ═══════════════════════════════════════════════════════════════════════════
//
// `bun test` runs this file but does not typecheck it: only `bun run typecheck`
// (`bun check`) evaluates the assertions below, and `lint` runs both. The
// point is that a type silently widening back to `string` or `EnvValues` fails
// the build instead of quietly degrading every consumer's inference.
//
// The factory probes are never called. `createDevEnvironment` allocates and
// claims a port block in `~/.buncargo/offsets.json`, so instantiating one at
// import time would make a type test write machine state.

type Expect<T extends true> = T;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

// ───────────────────────────────────────────────────────────────────────────
// A config exercising every inference path at once
// ───────────────────────────────────────────────────────────────────────────

const config = defineDevConfig({
	projectPrefix: "guardrails",
	services: {
		postgres: service.postgres(),
		mailpit: service.mailpit(),
	},
	apps: {
		web: {
			port: 3000,
			devCommand: "bun run dev",
			staticEnv: { WEB_STATIC: "static" },
			envVars: (ports) => ({ WEB_DERIVED: String(ports.web) }),
		},
		api: {
			port: 3001,
			devCommand: "bun run dev",
			captures: {
				token: { pattern: /token: (\S+)/, as: "value", env: "API_TOKEN" },
			},
		},
	},
	env: (ports) => ({ VITE_PORT: ports.web }),
});

declare const env: ReturnType<
	typeof createDevEnvironment<
		typeof config.services,
		NonNullable<typeof config.apps>,
		{ VITE_PORT: number }
	>
>;

type Env = typeof env;
type SharedEnv = ReturnType<Env["buildEnvVars"]>;
type WebEnv = ReturnType<typeof env.buildAppEnvVars<"web">>;

// The declared instantiation above has to match what the factory actually
// infers from the config, or every assertion below tests the wrong type.
function _probeFactoryInference() {
	const inferred = createDevEnvironment(config);
	type _FactoryMatchesDeclared = Expect<Equal<typeof inferred, Env>>;
	return inferred;
}

// ───────────────────────────────────────────────────────────────────────────
// Service and app keys survive the factory
// ───────────────────────────────────────────────────────────────────────────

type _AppKeys = Expect<Equal<keyof Env["apps"], "web" | "api">>;
type _ServiceKeys = Expect<
	Equal<keyof Env["services"], "postgres" | "mailpit">
>;
type _PortKeys = Expect<
	Equal<
		keyof Env["ports"],
		"postgres" | "mailpit" | "mailpitSecondary" | "web" | "api"
	>
>;

// ───────────────────────────────────────────────────────────────────────────
// The `env` overlay reaches the built surface
// ───────────────────────────────────────────────────────────────────────────

// A built environment is stringified for child processes, so every value is a
// string no matter what the overlay declared.
type _OverlayKeyIsPresent = Expect<Equal<SharedEnv["VITE_PORT"], string>>;
type _DerivedPortIsPresent = Expect<Equal<SharedEnv["WEB_PORT"], string>>;
type _DerivedUrlIsPresent = Expect<Equal<SharedEnv["POSTGRES_URL"], string>>;
// A hyphenated key's names carry an underscore, as `envName` writes them.
type HyphenEnv = ComputedEnvVars<
	{ "my-db": ServiceConfig & { port: number } },
	Record<never, AppConfig>
>;
type _HyphenStemIsUnderscored = Expect<Equal<HyphenEnv["MY_DB_PORT"], string>>;

// A service preset's `staticEnv` reaches the shared surface.
type _ServiceStaticEnv = Expect<Equal<SharedEnv["SMTP_HOST"], string>>;

// Host-only vars are optional: `env-vars.ts` sets them only when hosts are on.
type _HostOnlyOptional = Expect<
	Equal<SharedEnv["NODE_EXTRA_CA_CERTS"], string | undefined>
>;
// A capture's `env` is set once the app prints the value.
type _CaptureEnvOptional = Expect<
	Equal<SharedEnv["API_TOKEN"], string | undefined>
>;

// `getEnvVar` is the surface that keeps the overlay's declared type, so a
// `vite.config.ts` reading a port gets a `number` rather than a string.
function _probeGetEnvVar() {
	const vitePort = getEnvVar(config, "VITE_PORT");
	type _OverlayTypeSurvives = Expect<Equal<typeof vitePort, number>>;

	const dbUrl = getEnvVar(config, "DATABASE_URL");
	type _ComputedNameStaysWide = Expect<
		Equal<typeof dbUrl, string | number | undefined>
	>;

	// `getEnvVar` answers what the run has: captures and the workspace id.
	const token = getEnvVar(config, "API_TOKEN");
	const workspace = getEnvVar(config, "BUNCARGO_WORKSPACE_ID");

	// @ts-expect-error - "NOPE" is not a name this config produces
	return [vitePort, dbUrl, token, workspace, getEnvVar(config, "NOPE")];
}

// ───────────────────────────────────────────────────────────────────────────
// The shared surface is closed
// ───────────────────────────────────────────────────────────────────────────

type _RejectsUnknownName = Expect<
	Equal<"NOPE" extends keyof SharedEnv ? true : false, false>
>;
// An app's own `envVars` / `staticEnv` stay off the shared surface.
type _AppKeysNotShared = Expect<
	Equal<"WEB_DERIVED" extends keyof SharedEnv ? true : false, false>
>;

// A wide `EnvValues` overlay must not reopen the record either.
type WideEnv = ComputedEnvVars<
	{ postgres: ServiceConfig },
	{ web: AppConfig },
	EnvValues
>;
type _WideRejectsUnknown = Expect<
	Equal<"ANYTHING" extends keyof WideEnv ? true : false, false>
>;

// `ComputedPorts` has no index signature either, so a typo is not a `number`.
type _PortsAreClosed = Expect<
	Equal<
		"typo" extends keyof ComputedPorts<
			{ postgres: ServiceConfig },
			{ web: AppConfig }
		>
			? true
			: false,
		false
	>
>;

// ───────────────────────────────────────────────────────────────────────────
// `buildAppEnvVars` adds the app's own keys plus the injected PORT / HOST
// ───────────────────────────────────────────────────────────────────────────

type _AppEnvHasDerived = Expect<Equal<WebEnv["WEB_DERIVED"], string>>;
type _AppEnvHasStatic = Expect<Equal<WebEnv["WEB_STATIC"], string>>;
type _AppEnvHasPort = Expect<Equal<WebEnv["PORT"], string>>;
type _AppEnvHasHost = Expect<Equal<WebEnv["HOST"], string>>;
type _AppEnvKeepsShared = Expect<Equal<WebEnv["VITE_PORT"], string>>;

// ───────────────────────────────────────────────────────────────────────────
// Concrete configs stay assignable to the widened aliases
// ───────────────────────────────────────────────────────────────────────────

const noAppsConfig = defineDevConfig({
	projectPrefix: "guardrails",
	services: { postgres: service.postgres() },
});

type _TypedConfigIsAny = Expect<
	Equal<typeof config extends AnyDevConfig ? true : false, true>
>;
// The no-apps instantiation has to widen too, or a config without `apps` cannot
// reach the runtime-generic helpers at all.
type _NoAppsConfigIsAny = Expect<
	Equal<typeof noAppsConfig extends AnyDevConfig ? true : false, true>
>;
type _TypedEnvironmentIsAny = Expect<
	Equal<Env extends AnyDevEnvironment ? true : false, true>
>;
// Phase 3: `prisma.service` and `prisma.urlEnvVar` are keyed on the config.
type _PrismaServiceIsKeyed = Expect<
	Equal<
		NonNullable<
			PrismaConfig<{ postgres: ServiceConfig }, { web: AppConfig }>["service"]
		>,
		"postgres"
	>
>;
// The service and app records widen on their own, which is what lets the
// planning and docker modules keep `Record<string, …>` signatures cast-free.
type _ServicesWiden = Expect<
	Equal<
		typeof config.services extends Record<string, ServiceConfig> ? true : false,
		true
	>
>;
type _AppsWiden = Expect<
	Equal<
		NonNullable<typeof config.apps> extends Record<string, AppConfig>
			? true
			: false,
		true
	>
>;

// ═══════════════════════════════════════════════════════════════════════════
// Compile-time rejections
// ═══════════════════════════════════════════════════════════════════════════

describe("config inference guardrails", () => {
	it("rejects an unknown app in onlyApps", () => {
		const options = {
			// @ts-expect-error - "mobile" is not a configured app key
			onlyApps: ["mobile"],
		} satisfies Parameters<Env["start"]>[0];
		expect(options.onlyApps).toEqual(["mobile"]);
	});

	it("keys a start's pids by app, so a typo is no number", () => {
		const pids: NonNullable<Awaited<ReturnType<Env["start"]>>> = { web: 1 };
		const web: number | undefined = pids.web;
		// @ts-expect-error - "typo" is not a configured app key
		const typo = pids.typo;
		expect([web, typo]).toEqual([1, undefined]);
	});

	it("rejects an unknown expose target name", () => {
		const options = {
			// @ts-expect-error - "mobile" is not an exposed service or app
			names: ["mobile"],
		} satisfies Parameters<Env["openPublicTunnels"]>[0];
		expect(options.names).toEqual(["mobile"]);
	});

	it("keeps the overlay value typed through getEnvVar", () => {
		expect(getEnvVar(config, "VITE_PORT")).toBeNumber();
	});

	it("rejects a partial type-argument list on defineDevConfig", () => {
		const services = { postgres: service.postgres() };
		const apps = { web: { port: 3000, devCommand: "bun run dev" } };

		// Only `TApps` has a default, so supplying two arguments cannot bind
		// `typeof apps` to `TEnv` and erase the overlay keys. Passing explicit
		// arguments at all is the mistake; this asserts it is a loud one.
		// @ts-expect-error - explicit type arguments suppress inference
		const partial = defineDevConfig<typeof services, typeof apps>({
			projectPrefix: "partial",
			services,
			apps,
			env: () => ({ VITE_PORT: 3000 }),
		});

		expect(partial.projectPrefix).toBe("partial");
	});
});

// Merging reusable configs retains new keys and replaces overlapping value types.
function _probeMergedConfig() {
	const base = defineDevConfig({
		projectPrefix: "merge-types",
		services: { db: service.postgres() },
		apps: { api: { port: 3000, devCommand: false } },
		env: () => ({ MODE: "base" as const, BASE: 1 }),
	});
	const merged = mergeConfigs(base, {
		services: { cache: service.redis() },
		apps: { web: { port: 5173, devCommand: "npm run dev" } },
		env: (ports) => ({
			MODE: "override" as const,
			CACHE: ports.cache,
			WEB: ports.web,
		}),
	});
	type _Services = Expect<Equal<keyof typeof merged.services, "db" | "cache">>;
	type _Apps = Expect<
		Equal<keyof NonNullable<typeof merged.apps>, "api" | "web">
	>;
	type Overlay = ReturnType<NonNullable<typeof merged.env>>;
	type _OverrideWins = Expect<Equal<Overlay["MODE"], "override">>;
	type _OverlayKeys = Expect<
		Equal<keyof Overlay, "BASE" | "MODE" | "CACHE" | "WEB">
	>;
	const env = createDevEnvironment(merged);
	const url: string = env.urls.web;
	const value: number = getEnvVar(merged, "CACHE");
	// @ts-expect-error - merging does not widen the namespace to arbitrary keys
	getEnvVar(merged, "MISSING");
	return { url, value };
}

function _probeMergeWithoutBaseApps() {
	const merged = mergeConfigs(
		{ projectPrefix: "no-app-base", services: {} },
		{ apps: { web: { port: 3000, devCommand: "pnpm dev" } } },
	);
	type _Apps = Expect<Equal<keyof NonNullable<typeof merged.apps>, "web">>;
	return merged;
}

function _probeMergeAddingFirstEnvBuilder() {
	const base = defineDevConfig({
		projectPrefix: "first-overlay",
		services: {},
	});
	const merged = mergeConfigs(base, { env: () => ({ FEATURE: "enabled" }) });
	type _EnvKeys = Expect<
		Equal<keyof ReturnType<NonNullable<typeof merged.env>>, "FEATURE">
	>;
	const value: string = getEnvVar(merged, "FEATURE");
	const raw = mergeConfigs(
		{ projectPrefix: "raw-overlay", services: {} },
		{ env: () => ({ FLAG: 1 }) },
	);
	type _RawEnvKeys = Expect<
		Equal<keyof ReturnType<NonNullable<typeof raw.env>>, "FLAG">
	>;
	return { value, raw };
}

// A misspelt app key is inferred into `TApps`; the definitions `defineDevConfig`
// checks against turn it into `never`, so no value can satisfy it.
type _MisspeltAppKey = Expect<
	Equal<
		TypedAppDefinitions<
			Record<string, never>,
			{ api: { port: 3000; devCommand: "dev"; healthEndpont: "/health" } }
		>["api"]["healthEndpont"],
		never
	>
>;

function _probeBarePresetKey() {
	const config = defineDevConfig({
		projectPrefix: "bare",
		services: { postgres: { port: 5432 }, db: service.postgres() },
	});
	// A bare preset key derives its preset's env, like the helper does.
	const bare: string | number | undefined = getEnvVar(config, "DATABASE_URL");
	return bare;
}

// Integration-added keys are typed through the config's own `integrations`
// tuple: a name compiles only in a config that lists the integration adding it.
function _probeIntegrationAddedKeys() {
	const withSupabase = defineDevConfig({
		projectPrefix: "supabase-keys",
		services: {},
		apps: {
			web: {
				port: 5173,
				devCommand: "bun run dev",
				requiredServices: ["supabase", "supabaseDb"],
			},
		},
		tasks: { types: { command: "bun gen", requiredServices: ["supabaseDb"] } },
		integrations: [supabase()],
	});
	const withoutSupabase = defineDevConfig({
		projectPrefix: "supabase-keys",
		services: {},
		apps: {
			web: {
				port: 5173,
				devCommand: "bun run dev",
				// @ts-expect-error - no integration in this config adds "supabase"
				requiredServices: ["supabase"],
			},
		},
	});
	const functionsOff = defineDevConfig({
		projectPrefix: "supabase-functions",
		services: {},
		// @ts-expect-error - "supabaseFunctions" needs `functions: true`
		profiles: { edge: { apps: ["supabaseFunctions"] } },
		integrations: [supabase()],
	});
	const functionsOn = defineDevConfig({
		projectPrefix: "supabase-functions",
		services: {},
		profiles: { edge: { apps: ["supabaseFunctions"] } },
		integrations: [supabase({ functions: true })],
	});
	const firebaseAndShopify = defineDevConfig({
		projectPrefix: "firebase-keys",
		services: {},
		apps: {
			web: {
				port: 3000,
				devCommand: "next dev",
				startAfter: ["firebase"],
				requiredApps: ["shopify"],
			},
		},
		profiles: { full: { apps: ["web", "firebase", "shopify"] } },
		integrations: [firebase(), shopify()],
	});
	const misspelt = defineDevConfig({
		projectPrefix: "misspelt",
		services: {},
		apps: {
			// @ts-expect-error - a misspelt app option is never a valid key
			api: { port: 3000, devCommand: "dev", healthEndpont: "/health" },
		},
	});
	// An integration's names never become one of the config's own keys.
	type _OwnAppsOnly = Expect<
		Equal<keyof NonNullable<typeof firebaseAndShopify.apps>, "web">
	>;
	return [withSupabase, withoutSupabase, functionsOff, functionsOn, misspelt];
}
