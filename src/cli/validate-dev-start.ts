import { resolveExposeTargets } from "../core/tunnel";
import { assertAppWorkingDirectories } from "../environment/servers";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import type { DevCliArgs } from "./dev-flags";
import { CliError } from "./errors";

/** Fail argv/config combinations before publishing routes or starting containers. */
export function validateDevStart<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	args: DevCliArgs,
	apps: Record<string, AppConfig>,
	serviceNames: string[],
): void {
	if (args.attach && typeof apps[args.attach]?.devCommand !== "string")
		throw new CliError(
			`--attach=${args.attach} is not a startable selected app.`,
		);
	if (!args.oneShot) assertAppWorkingDirectories(apps, env.root);
	if (!args.exposeRequested) return;
	const result = resolveExposeTargets(env, args.exposeValue);
	if (result.unknownNames.length || result.notEnabledNames.length)
		throw new CliError(
			`Invalid expose targets: ${[...result.unknownNames, ...result.notEnabledNames].join(", ")}`,
		);
	const selectedServices = new Set(serviceNames);
	const included = result.targets.filter((target) =>
		target.kind === "app"
			? apps[target.name] !== undefined
			: selectedServices.has(target.name),
	);
	if (args.exposeValue !== undefined) {
		const excluded = result.targets.filter(
			(target) => !included.includes(target),
		);
		if (excluded.length)
			throw new CliError(
				`Expose targets are outside the selected app/service set: ${excluded.map((target) => target.name).join(", ")}. Include their apps in --apps.`,
			);
	}
	if (!included.length)
		throw new CliError(
			"No expose targets selected. Add expose: true to selected services/apps.",
		);
}
