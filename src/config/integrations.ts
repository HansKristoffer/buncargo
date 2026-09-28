import { formatWarn } from "../core/style";
import { expo } from "../expo";
import { isExpoApp } from "../expo/simulator";
import type {
	AppConfig,
	BuncargoIntegration,
	DevHooks,
	IntegrationConfig,
	ServiceConfig,
} from "../types";

type AnyHooks = DevHooks<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

/** Marks a config whose integrations have been applied, so applying is idempotent. */
const APPLIED = Symbol.for("buncargo.integrations.applied");

let warnedLegacyExpo = false;

/**
 * Expo predates integrations: an `expo` field on an app, `options.expoApiApp`,
 * or a `devCommand` that runs `expo` switched it on from core. For one major
 * those keep working by adding `expo()` here, with a warning naming the
 * replacement.
 */
function withLegacyExpo(
	config: IntegrationConfig,
	integrations: readonly BuncargoIntegration[],
): readonly BuncargoIntegration[] {
	if (integrations.some((integration) => integration.name === "expo")) {
		return integrations;
	}
	const apps = Object.values(config.apps ?? {});
	const legacy =
		apps.some((app) => app.expo !== undefined && app.expo !== false) ||
		config.options?.expoApiApp !== undefined;
	if (!legacy && !apps.some((app) => isExpoApp(app))) return integrations;

	if (!warnedLegacyExpo) {
		warnedLegacyExpo = true;
		console.warn(
			formatWarn(
				'Expo support moved to an integration: add `integrations: [expo()]` (from "buncargo/expo") to dev.config.ts. The `expo` app field and `options.expoApiApp` still work until the next major.',
			),
		);
	}
	return [...integrations, expo({ apiApp: config.options?.expoApiApp })];
}

/** Each hook runs the config's own first, then every integration's, in order. */
function composeHooks(
	own: AnyHooks | undefined,
	integrations: readonly BuncargoIntegration[],
): AnyHooks | undefined {
	const sources = [
		own,
		...integrations.map((integration) => integration.hooks),
	].filter((hooks): hooks is AnyHooks => hooks !== undefined);
	if (sources.length <= 1) return sources[0];

	const names = new Set(sources.flatMap((hooks) => Object.keys(hooks)));
	return Object.fromEntries(
		[...names].map((name) => [
			name,
			async (...args: unknown[]) => {
				for (const hooks of sources) {
					const hook = hooks[name as keyof AnyHooks] as
						| ((...hookArgs: unknown[]) => unknown)
						| undefined;
					await hook?.(...args);
				}
			},
		]),
	) as AnyHooks;
}

/**
 * Apply a config's integrations: each `config()` transform in order, then the
 * hooks and checks they contribute. Runs before validation, so everything an
 * integration adds is validated like the rest.
 */
export function applyIntegrations<T extends object>(config: T): T {
	const input = config as IntegrationConfig;
	if ((input as { [APPLIED]?: true })[APPLIED]) return config;

	const integrations = withLegacyExpo(input, input.integrations ?? []);
	if (integrations.length === 0) return config;

	let resolved = input;
	for (const integration of integrations) {
		if (!integration.config) continue;
		try {
			resolved = integration.config(resolved);
		} catch (error) {
			throw new Error(
				`Integration "${integration.name}" failed to apply: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const hooks = composeHooks(resolved.hooks, integrations);
	const checks = [
		...(resolved.checks ?? []),
		...integrations.flatMap((integration) => integration.checks ?? []),
	];
	return Object.assign(
		{
			...resolved,
			integrations,
			...(hooks ? { hooks } : {}),
			...(checks.length > 0 ? { checks } : {}),
		},
		{ [APPLIED]: true },
	) as T;
}

/** Test-only: warn about the legacy Expo fields again. */
export function resetLegacyExpoWarning(): void {
	warnedLegacyExpo = false;
}
