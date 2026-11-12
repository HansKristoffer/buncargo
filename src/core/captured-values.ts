import type { CaptureConfig } from "../types";

/** What captures read off an app: a resolved one or one as written. */
type CapturingApp = { captures?: Readonly<Record<string, CaptureConfig>> };

/** Every capture config that asked for `key`, with the value it captured. */
function capturedWith(
	apps: Readonly<Record<string, CapturingApp>>,
	captured: Readonly<Record<string, string>>,
	key: "label" | "env",
): [string, string][] {
	return Object.values(apps).flatMap((app) =>
		Object.entries(app.captures ?? {}).flatMap(([name, capture]) => {
			const target = capture[key];
			const value = captured[name];
			if (key === "label" && capture.secret) return [];
			return target && value ? [[target, value] as [string, string]] : [];
		}),
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
