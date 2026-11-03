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

/**
 * A seed that exited non-zero. Carries the command and its last lines, so the
 * CLI can say which step failed and show why at the end of its output.
 */
export class SeedFailedError extends Error {
	readonly exitCode: number;
	readonly command: string;
	readonly tail: readonly string[];

	constructor(outcome: Extract<SeedOutcome, { status: "failed" }>) {
		const { exitCode } = outcome.result;
		super(
			`Seeding failed with exit code ${exitCode}. Fix the seed command or start with \`--up-only\` to skip it.`,
		);
		this.name = "SeedFailedError";
		this.exitCode = exitCode;
		this.command = outcome.command;
		this.tail = outcome.tail;
	}
}

export function assertSeedSucceeded(outcome: SeedOutcome): void {
	if (outcome.status === "failed") throw new SeedFailedError(outcome);
}
