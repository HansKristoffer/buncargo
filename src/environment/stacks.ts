import type {
	BuncargoIntegration,
	IntegrationStack,
	ResolvedComposeService,
	ResolvedService,
} from "../types";

/** What finding a config's stacks reads. */
interface StackSource {
	services: Readonly<Record<string, ResolvedService>>;
	integrations?: readonly BuncargoIntegration[];
}

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
	config: StackSource,
	serviceKeys: readonly string[],
): ResolvedStack[] {
	const wanted = new Set(
		serviceKeys.flatMap((key) => {
			const service = config.services[key];
			return service?.kind === "external" ? [service.stack] : [];
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
export function configuredStacks(config: StackSource): ResolvedStack[] {
	return stacksForServices(config, Object.keys(config.services));
}

/** Services the generated Compose file runs: everything not provided by a stack. */
export function composeServicesOf(
	services: Readonly<Record<string, ResolvedService>>,
): Record<string, ResolvedComposeService> {
	return Object.fromEntries(
		Object.entries(services).filter(
			(entry): entry is [string, ResolvedComposeService] =>
				entry[1].kind !== "external",
		),
	);
}
