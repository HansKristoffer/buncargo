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
 * hooks, checks and preflight steps they contribute. Runs before validation, so everything an
 * integration adds is validated like the rest.
 */
export function applyIntegrations<T extends object>(config: T): T {
	const input = config as IntegrationConfig;
	if ((input as { [APPLIED]?: true })[APPLIED]) return config;

	const integrations = input.integrations ?? [];
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
	const preflight = [
		...(resolved.preflight ?? []),
		...integrations.flatMap((integration) => integration.preflight ?? []),
	];
	return Object.assign(
		{
			...resolved,
			integrations,
			...(hooks ? { hooks } : {}),
			...(checks.length > 0 ? { checks } : {}),
			...(preflight.length > 0 ? { preflight } : {}),
		},
		{ [APPLIED]: true },
	) as T;
}
