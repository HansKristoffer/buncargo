import { withDeadline } from "../core/deadline";
import type { CapturedValue } from "../core/process/output-capture";
import { formatDone } from "../core/style";
import type { AppConfig, EnvValues, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import { renderGeneratedFiles } from "./generated-files";

/**
 * What a captured value changes, applied in one place for every spawner.
 *
 * A `publicUrl` becomes `publicUrls.<app>` exactly as a tunnel URL would; a
 * `value` becomes `captured.<name>`. Hooks see every capture, events included.
 * Generated files re-render only when something they read actually changed.
 */
export function createCaptureRecorder<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
) {
	return async function recordCapture(
		app: string,
		captured: CapturedValue,
	): Promise<readonly string[]> {
		const changed: string[] = [];
		if (captured.as === "publicUrl" && ctx.publicUrls[app] !== captured.value) {
			// `setPublicUrls` replaces the map; keep the tunnels' URLs.
			ctx.setPublicUrls({ ...ctx.publicUrls, [app]: captured.value });
			changed.push(`publicUrls.${app}`);
		}
		if (
			captured.as !== "event" &&
			ctx.captured[captured.name] !== captured.value
		) {
			ctx.captured[captured.name] = captured.value;
			changed.push(`captured.${captured.name}`);
		}

		const hook = ctx.config.hooks?.onCapture;
		if (hook) {
			await withDeadline(async (signal) => {
				await hook(
					{ app, name: captured.name, value: captured.value },
					envVars.getHookContext(signal),
				);
			}, 60_000);
		}

		if (changed.length > 0) {
			for (const path of renderGeneratedFiles(ctx, envVars)) {
				console.log(formatDone(`Updated ${path}`));
			}
		}
		return changed;
	};
}
