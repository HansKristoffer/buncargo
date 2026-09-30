import type { SeedOutcome, ServiceConfig } from "../types";

type SeedSelection = {
	beforeApps?: boolean;
	requiredServices?: readonly string[];
};

export function seedCanOverlap(
	seed: SeedSelection | undefined,
	services: Record<string, ServiceConfig>,
	selected: readonly string[],
): boolean {
	return (
		seed?.beforeApps === false &&
		(seed.requiredServices
			? seed.requiredServices.every((name) => selected.includes(name))
			: selected.length > 0) &&
		!selected.some((name) => services[name]?.afterPreparation)
	);
}

export function assertSeedSucceeded(outcome: SeedOutcome): void {
	if (outcome.status === "failed")
		throw new Error(
			`Seeding failed with exit code ${outcome.result.exitCode}. Fix the seed command or start with \`--up-only\` to skip it.`,
		);
}

/** Fail fast on either side; callers drain this task when app startup fails. */
export function startSeedTask(
	run: (signal: AbortSignal) => Promise<SeedOutcome>,
	parent?: AbortSignal,
) {
	const controller = new AbortController();
	const signal = parent
		? AbortSignal.any([parent, controller.signal])
		: controller.signal;
	const ready = Promise.resolve()
		.then(() => run(signal))
		.then(assertSeedSucceeded)
		.catch((error) => {
			controller.abort(error);
			throw error;
		});
	void ready.catch(() => {});
	return {
		ready,
		signal,
		cancel: (error?: unknown) => controller.abort(error),
	};
}
