import { resolveExposeTargets } from "../core/tunnel";
import type { EnvironmentInternals } from "../environment";
import { assertAppWorkingDirectories } from "../environment/servers";
import type {
	AppConfig,
	DevEnvironment,
	ResolvedApp,
	ServiceConfig,
} from "../types";
import {
	type DevArgs,
	exposeRequested,
	exposeTargets,
	isOneShot,
} from "./dev-flags";
import { CliError } from "./errors";

/** Fail argv/config combinations before publishing routes or starting containers. */
export function validateDevStart<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	args: DevArgs,
	apps: Record<string, ResolvedApp>,
	serviceNames: string[],
	/** The config's `seed`, which `--seed` needs services for. */
	seedConfig: EnvironmentInternals["seed"],
): void {
	const { attach, seed } = args.values;

	if (attach && typeof apps[attach]?.devCommand !== "string") {
		throw new CliError(`--attach=${attach} is not a startable selected app.`);
	}

	if (!isOneShot(args.values)) assertAppWorkingDirectories(apps, env.root);

	if (seed) {
		const error = seedSelectionError(seedConfig, serviceNames, env);
		if (error) throw error;
	}

	if (!exposeRequested(args.values)) return;

	const targets = exposeTargets(args.values);
	const result = resolveExposeTargets(env, targets);

	const invalidNames = [...result.unknownNames, ...result.notEnabledNames];
	if (invalidNames.length > 0) {
		const hints: string[] = [];
		if (result.unknownNames.length > 0) {
			hints.push(
				`Not an app or service of this config: ${result.unknownNames.join(", ")}`,
			);
		}
		if (result.notEnabledNames.length > 0) {
			hints.push(
				`Set expose: true on ${result.notEnabledNames.join(", ")} in the dev config to share it.`,
			);
		}
		throw new CliError(
			`Invalid expose targets: ${invalidNames.join(", ")}`,
			hints,
		);
	}

	const selectedServices = new Set(serviceNames);
	const included = result.targets.filter((target) =>
		target.kind === "app"
			? apps[target.name] !== undefined
			: selectedServices.has(target.name),
	);

	// With no names given, every `expose: true` target is shared and the ones
	// outside the selection are skipped. Named targets must all be selected.
	if (targets !== undefined) {
		const excluded = result.targets.filter(
			(target) => !included.includes(target),
		);
		if (excluded.length > 0) {
			const names = excluded.map((target) => target.name).join(", ");
			throw new CliError(
				`Expose targets are outside the selected app/service set: ${names}. Include their apps in --apps.`,
			);
		}
	}

	if (included.length === 0) {
		throw new CliError(
			"No expose targets selected. Add expose: true to selected services/apps.",
		);
	}
}

/** A typo in `--apps` names the apps it could have meant. */
export function assertConfiguredApps(
	configured: readonly string[],
	requested: readonly string[],
): void {
	const unknown = requested.filter((name) => !configured.includes(name));
	if (unknown.length === 0) return;

	const plural = unknown.length === 1 ? "" : "s";
	const hint =
		configured.length > 0
			? `Configured apps: ${configured.join(", ")}`
			: "This config has no apps; run without --apps to start its services.";
	throw new CliError(`Unknown app${plural} in --apps: ${unknown.join(", ")}.`, [
		hint,
	]);
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
		readonly apps: Record<string, ResolvedApp>;
		readonly services: Record<string, unknown>;
	},
): CliError | undefined {
	if (!seed) return undefined;

	const required = seed.requiredServices;

	// No `requiredServices` means the seed runs against whichever services are selected.
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
