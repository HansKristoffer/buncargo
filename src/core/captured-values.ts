import type { CaptureConfig } from "../types";

/** What captures read off an app: a resolved one or one as written. */
type CapturingApp = { captures?: Readonly<Record<string, CaptureConfig>> };

/** Every capture config that asked for `key`, with the value it captured. */
function capturedWith(
	apps: Readonly<Record<string, CapturingApp>>,
	captured: Readonly<Record<string, string>>,
	key: "label" | "env",
	options: { excludeSecret?: boolean } = {},
): [string, string][] {
	const skipSecret = key === "label" || options.excludeSecret === true;
	return Object.values(apps).flatMap((app) =>
		Object.entries(app.captures ?? {}).flatMap<[string, string]>(
			([name, capture]) => {
				const target = capture[key];
				const value = captured[name];

				if (skipSecret && capture.secret) return [];

				return target && value ? [[target, value]] : [];
			},
		),
	);
}

/** Captured values under their `label`; a `secret` one is never shown. */
export function labelledCaptures(
	apps: Readonly<Record<string, CapturingApp>>,
	captured: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(capturedWith(apps, captured, "label"));
}

/** Captured values under their `env` name. */
export function capturedEnv(
	apps: Readonly<Record<string, CapturingApp>>,
	captured: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(capturedWith(apps, captured, "env"));
}

/** Non-secret captured values under their `env` name, safe for `runs.json` exports. */
export function publicCapturedEnv(
	apps: Readonly<Record<string, CapturingApp>>,
	captured: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		capturedWith(apps, captured, "env", { excludeSecret: true }),
	);
}

/** Env var names populated by `secret: true` captures across all configured apps. */
export function secretCaptureEnvKeys(
	apps: Readonly<Record<string, CapturingApp>>,
): Set<string> {
	const keys = new Set<string>();
	for (const app of Object.values(apps)) {
		for (const capture of Object.values(app.captures ?? {})) {
			if (capture.secret && capture.env) keys.add(capture.env);
		}
	}
	return keys;
}
