import type { AnyDevConfig, IntegrationStack, ServiceConfig } from "../types";

/**
 * Integration stacks (see `BuncargoIntegration.stacks`): services a CLI
 * starts and stops itself, which buncargo gives ports, URLs and env.
 */

export interface ResolvedStack {
	name: string;
	stack: IntegrationStack;
}

/** The stacks providing these services, each once, in declaration order. */
export function stacksForServices(
	config: AnyDevConfig,
	serviceKeys: readonly string[],
): ResolvedStack[] {
	const wanted = new Set(
		serviceKeys.flatMap((key) => {
			const stack = (config.services[key] as ServiceConfig | undefined)
				?.external?.stack;
			return stack ? [stack] : [];
		}),
	);
	const stacks: ResolvedStack[] = [];
	for (const integration of config.integrations ?? []) {
		for (const [name, stack] of Object.entries(integration.stacks ?? {})) {
			if (wanted.delete(name)) stacks.push({ name, stack });
		}
	}
	return stacks;
}

/** Every stack some service of this config is provided by. */
export function configuredStacks(config: AnyDevConfig): ResolvedStack[] {
	return stacksForServices(config, Object.keys(config.services));
}

/** Services the generated Compose file runs: everything not provided by a stack. */
export function composeServicesOf<T extends Record<string, ServiceConfig>>(
	services: T,
): T {
	return Object.fromEntries(
		Object.entries(services).filter(([, service]) => !service.external),
	) as T;
}
