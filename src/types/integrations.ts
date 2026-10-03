import type { AppConfig } from "./app";
import type { PreflightStep, SetupCheck } from "./commands";
import type { DevConfig } from "./config";
import type { AnyDevEnvironment } from "./environment";
import type { DevHooks, HookContext } from "./hooks";
import type { ServiceConfig } from "./service";

// ═══════════════════════════════════════════════════════════════════════════
// Integrations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * App keys that integrations add to a config, so `profiles` and the like can
 * name them. An integration's module augments this:
 *
 * ```ts
 * declare module "buncargo" { interface IntegrationAppNames { shopify: true } }
 * ```
 */

/** A config as an integration sees it: keys are only known as strings. */
export type IntegrationConfig = DevConfig<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

/** One app, as handed to {@link BuncargoIntegration.appEnv} and `describeApp`. */
export interface IntegrationAppContext {
	name: string;
	config: AppConfig;
	/** Its allocated port; absent for workers. */
	port?: number;
	root: string;
	workspaceId: string;
}

/** The runtime an integration command gets. */
export interface IntegrationCommandContext {
	/** Arguments after `buncargo <integration> <command>`. */
	args: string[];
	/** Monorepo root of the working directory, when there is one. */
	root: string | undefined;
	/** Load `dev.config.ts`. Commands that only read the run registry skip it. */
	loadEnv(): Promise<AnyDevEnvironment>;
}

/** `buncargo <integration> <name>`. */
export interface IntegrationCommand {
	summary: string;
	usage?: string;
	/** Returns the exit code. */
	run(ctx: IntegrationCommandContext): number | Promise<number>;
}

/**
 * Project-type knowledge packaged for any config: `buncargo/shopify`,
 * `buncargo/expo`. A plain object, so writing one needs nothing from buncargo
 * but these types.
 */
export interface BuncargoIntegration {
	/** Also its CLI namespace: `buncargo <name> <command>`. */
	name: string;
	/**
	 * Transform the config: add apps, services, env, generated files. Pure, and
	 * runs before validation, so what it adds is validated like the rest.
	 */
	config?(config: IntegrationConfig): IntegrationConfig;
	/** Run beside the config's own hooks, after them. */
	hooks?: DevHooks<Record<string, ServiceConfig>, Record<string, AppConfig>>;
	/** Shown by `buncargo doctor`, run by `buncargo setup`; fast ones by `dev`. */
	checks?: readonly SetupCheck[];
	/** Run by `dev` with the terminal, before anything starts (a login). */
	preflight?: readonly PreflightStep[];
	/** `buncargo <name> <command>` */
	commands?: Readonly<Record<string, IntegrationCommand>>;
	/** Labelled values for `buncargo env`, the run registry and BuncargoBar. */
	describe?(
		ctx: HookContext<Record<string, ServiceConfig>, Record<string, AppConfig>>,
	): Record<string, string>;
	/** Env this integration adds to one app's process, beneath the app's own `envVars`. */
	appEnv?(app: IntegrationAppContext): Record<string, string> | undefined;
	/** Fields merged into the app's run-registry entry (what BuncargoBar reads). */
	describeApp?(app: IntegrationAppContext): Record<string, unknown> | undefined;
	/** A hint shown next to the app in the startup banner. */
	bannerHint?(app: IntegrationAppContext): string | undefined;
}
