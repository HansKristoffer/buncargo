import { describe, expect, it } from "bun:test";
import { defineDevConfig } from "../config";
import { getEnvVar } from "../core/utils";
import { service } from "../docker-compose/services";
import { createDevEnvironment } from "../environment";
import type {
	AnyDevConfig,
	AnyDevEnvironment,
	AppConfig,
	ComputedEnvVars,
	ComputedPorts,
	EnvValues,
	PrismaConfig,
	ServiceConfig,
} from ".";

// ═══════════════════════════════════════════════════════════════════════════
// Type-level guardrails
// ═══════════════════════════════════════════════════════════════════════════
//
// `bun test` runs this file but does not typecheck it: only `bun run typecheck`
// (tsgo) evaluates the assertions below, and the `lint` script runs both. The
// point is that a type silently widening back to `string` or `EnvValues` fails
// the build instead of quietly degrading every consumer's inference.
//
// The factory probes are never called. `createDevEnvironment` allocates and
// persists `.buncargo/ports.json`, so instantiating one at import time would
// make a type test rewrite a lockfile.

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
	? 1
	: 2
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
		api: { port: 3001, devCommand: "bun run dev" },
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

// A service preset's `staticEnv` reaches the shared surface.
type _ServiceStaticEnv = Expect<Equal<SharedEnv["SMTP_HOST"], string>>;

// Host-only vars are optional: `env-vars.ts` sets them only when hosts are on.
type _HostOnlyOptional = Expect<
	Equal<SharedEnv["NODE_EXTRA_CA_CERTS"], string | undefined>
>;

// `getEnvVar` is the surface that keeps the overlay's declared type, so a
// `vite.config.ts` reading a port gets a `number` rather than a string.
function _probeGetEnvVar() {
	const vitePort = getEnvVar(config, "VITE_PORT", { log: false });
	type _OverlayTypeSurvives = Expect<Equal<typeof vitePort, number>>;

	const dbUrl = getEnvVar(config, "DATABASE_URL", { log: false });
	type _ComputedNameStaysWide = Expect<
		Equal<typeof dbUrl, string | number | undefined>
	>;

	// @ts-expect-error - "NOPE" is not a name this config produces
	return [vitePort, dbUrl, getEnvVar(config, "NOPE")];
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

	it("rejects an unknown expose target name", () => {
		const options = {
			// @ts-expect-error - "mobile" is not an exposed service or app
			names: ["mobile"],
		} satisfies Parameters<Env["openPublicTunnels"]>[0];
		expect(options.names).toEqual(["mobile"]);
	});

	it("keeps the overlay value typed through getEnvVar", () => {
		expect(getEnvVar(config, "VITE_PORT", { log: false })).toBeNumber();
	});

	it("rejects a partial type-argument list on defineDevConfig", () => {
		const services = { postgres: service.postgres() };
		const apps = { web: { port: 3000, devCommand: "bun run dev" } };

		// No type parameter has a default, so supplying two of three cannot bind
		// `typeof apps` to `TEnv` and erase the overlay keys. Passing explicit
		// arguments at all is the mistake; this asserts it is a loud one.
		const partial = defineDevConfig<
			typeof services,
			// @ts-expect-error - explicit type arguments suppress TEnv inference
			typeof apps
		>({
			projectPrefix: "partial",
			services,
			apps,
			env: (ports) => ({ VITE_PORT: ports.web }),
		});

		expect(partial.projectPrefix).toBe("partial");
	});
});
