import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isCI } from "./runtime-flags";
import { chownToInvokingUser, getStateDir, stateFilePath } from "./state-paths";

/**
 * Asking the developer something, and remembering a "no".
 *
 * Every prompt buncargo has follows the same three rules, and they used to be
 * re-implemented per prompt: it needs a TTY on both ends, it must never fire in
 * CI, and a permanent "no" is a marker file in `~/.buncargo` rather than
 * anything in the repo. The readline plumbing was copied per call site too.
 *
 * The fourth rule is the one that cannot be written per prompt at all: **at
 * most one first-run prompt per run**. A fresh machine can hit both the named
 * hosts setup and the menu bar offer in the same `buncargo dev`, and stacking
 * two setup questions in front of someone who typed `bun dev` is exactly the
 * onboarding this avoids everywhere else. {@link claimFirstRunPrompt} is the
 * token they compete for; whoever asks first wins and the other waits for the
 * next run.
 */

export function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * May this run ask a first-run setup question?
 *
 * Not a check — a claim. The first caller gets `true` and every later caller in
 * the same process gets `false`, so the ordering in the dev flow decides which
 * prompt wins rather than a flag each prompt has to remember to pass on.
 */
let firstRunPromptClaimed = false;

export function claimFirstRunPrompt(): boolean {
	if (firstRunPromptClaimed) return false;
	firstRunPromptClaimed = true;
	return true;
}

/** Test seam: forget that a prompt was claimed. */
export function resetFirstRunPrompt(): void {
	firstRunPromptClaimed = false;
}

export interface PromptChoice<T> {
	/** Typed answer that selects this, lowercased. Empty string is bare Enter. */
	readonly key: string;
	readonly value: T;
}

/**
 * Ask a question and map the answer through `choices`.
 *
 * `lines` is the question body, printed verbatim; the trailing `  > ` prompt is
 * added here so every question looks the same. An answer matching no choice
 * falls back to the choice keyed `""` — bare Enter — which is why the safe
 * option is always the one keyed that way.
 */
export async function askChoice<T>(
	lines: string[],
	choices: readonly PromptChoice<T>[],
	fallback: T,
): Promise<T> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(["", ...lines, "  > "].join("\n"), resolve);
	});
	rl.close();
	const normalized = answer.trim().toLowerCase();
	const match = choices.find((choice) => choice.key === normalized);
	return match ? match.value : fallback;
}

/** Yes/no where a bare Enter means no. Used where "yes" stops someone's work. */
export async function askConfirm(lines: string[]): Promise<boolean> {
	return askChoice(
		lines,
		[
			{ key: "y", value: true },
			{ key: "yes", value: true },
		],
		false,
	);
}

export interface DeclineMarker {
	has(): boolean;
	persist(): void;
	clear(): void;
}

/**
 * A "do not ask me again" file in `~/.buncargo`.
 *
 * The timestamp inside is for a human reading the directory; only the file's
 * existence is ever checked.
 */
export function declineMarker(filename: string): DeclineMarker {
	return {
		has(): boolean {
			return existsSync(stateFilePath(filename));
		},
		persist(): void {
			mkdirSync(getStateDir(), { recursive: true });
			const path = stateFilePath(filename);
			writeFileSync(path, `${new Date().toISOString()}\n`);
			chownToInvokingUser(path);
		},
		clear(): void {
			try {
				unlinkSync(stateFilePath(filename));
			} catch {
				// Never existed, which is the state the caller wanted.
			}
		},
	};
}

/**
 * The gate every optional first-run offer shares.
 *
 * Kept separate from {@link askChoice} because the answer "we must not ask"
 * has to be distinguishable from "they said no": the caller usually reports
 * something different in each case.
 */
export function canPromptFirstRun(
	options: { marker?: DeclineMarker; env?: NodeJS.ProcessEnv } = {},
): boolean {
	const { marker, env = process.env } = options;
	if (isCI(env)) return false;
	if (!isInteractive()) return false;
	if (marker?.has()) return false;
	return true;
}
