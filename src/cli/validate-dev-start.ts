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
	if (args.seed) {
		const error = seedSelectionError(env.seed, serviceNames, env);
		if (error) throw error;
	}
	if (!args.exposeRequested) return;
	const result = resolveExposeTargets(env, args.exposeValue);
	if (result.unknownNames.length || result.notEnabledNames.length)
		throw new CliError(
			`Invalid expose targets: ${[...result.unknownNames, ...result.notEnabledNames].join(", ")}`,
			[
				...(result.unknownNames.length
					? [
							`Not an app or service of this config: ${result.unknownNames.join(", ")}`,
						]
					: []),
				...(result.notEnabledNames.length
					? [
							`Set expose: true on ${result.notEnabledNames.join(", ")} in the dev config to share it.`,
						]
					: []),
			],
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

/** A typo in `--apps` names the apps it could have meant. */
export function assertConfiguredApps(
	configured: readonly string[],
	requested: readonly string[],
): void {
	const unknown = requested.filter((name) => !configured.includes(name));
	if (unknown.length === 0) return;
	throw new CliError(
		`Unknown app${unknown.length === 1 ? "" : "s"} in --apps: ${unknown.join(", ")}.`,
		[
			configured.length > 0
				? `Configured apps: ${configured.join(", ")}`
				: "This config has no apps; run without --apps to start its services.",
		],
	);
}

/**
 * `--seed` with a selection that leaves out the services its seed needs.
 * The seed would be skipped, and a run that seeded nothing must not report
 * "Seeding complete". `undefined` when the seed can run.
 */
export function seedSelectionError(
	seed: { readonly requiredServices?: readonly string[] } | undefined,
	selectedServices: readonly string[],
	config: {
		readonly apps: Record<string, AppConfig>;
		readonly services: Record<string, unknown>;
	},
): CliError | undefined {
	if (!seed) return undefined;
	const required = seed.requiredServices;
	if (!required) {
		if (selectedServices.length > 0) return undefined;
		return new CliError(
			"--seed runs the seed against the selected services, and this selection starts none.",
			[
				...(Object.keys(config.services).length > 0
					? ["Run it without --apps or --profile to start every service."]
					: []),
				"Set seed.requiredServices: [] in dev.config.ts to seed without services.",
			],
		);
	}
	const missing = required.filter((name) => !selectedServices.includes(name));
	if (missing.length === 0) return undefined;
	const providers = Object.entries(config.apps)
		.filter(([, app]) =>
			app.requiredServices?.some((name) => missing.includes(name)),
		)
		.map(([name]) => name);
	return new CliError(
		`--seed needs ${missing.join(", ")}, which this selection does not start.`,
		[
			"Run it without --apps or --profile to start every service.",
			...(providers.length > 0
				? [`Or select an app that requires it: --apps=${providers.join(",")}`]
				: []),
		],
	);
}
