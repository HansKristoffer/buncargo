import type { AppConfig, DevConfigInput, ServiceConfig } from "../types";

/**
 * Define a typed dev config.
 *
 * `apps` is intersected with `TApps` only so app keys are inferred from the
 * object literal; the accepted type is otherwise exactly the returned
 * {@link DevConfigInput}, so no cast is needed.
 */
export function defineDevConfig<
	const TServices extends Record<string, ServiceConfig>,
	const TApps extends Record<string, AppConfig> = Record<string, never>,
>(
	config: DevConfigInput<TServices, TApps> & { apps?: TApps },
): DevConfigInput<TServices, TApps> {
	return config;
}
