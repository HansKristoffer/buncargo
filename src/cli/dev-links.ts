import { getErrorMessage } from "hanzio";
import { agentAwareProcessEnv } from "../core/child-env";
import { buncargoCli, type CliInvocation } from "../core/cli-entry";
import { EGRESS_GUARD_ENV_KEYS } from "../core/egress-guard/rules";
import { PORT_OFFSET_ENV } from "../core/runtime-flags";
import { shellQuote } from "../core/shell-quote";
import type { LinkInspection, ResolvedLinkConfig } from "../types";
import { CliError } from "./errors";

/** One missing linked repo scheduled to start via `buncargo dev --with-links`. */
export interface PlannedLinkStart {
	readonly name: string;
	readonly project: string;
	readonly targetRoot: string;
	readonly required: boolean;
	readonly profile?: string;
}

/**
 * Pick missing linked checkouts to start for one phase:
 * - `"before"`: `required: true` upstream links, started before this checkout.
 * - `"after"`: `required: false` downstream links, started once this checkout
 *   is ready in `runs.json`.
 *
 * Skips disabled, already-running, ambiguous, deleted-pin, mismatched-pin, or
 * pathless links so `--with-links` never guesses silently.
 */
export function planLinkedStarts(
	inspections: readonly LinkInspection[],
	linksConfig: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
	phase: "before" | "after",
): PlannedLinkStart[] {
	const wantRequired = phase === "before";
	const planned: PlannedLinkStart[] = [];

	for (const item of inspections) {
		if (item.status !== "not-running") continue;
		if (item.required !== wantRequired) continue;
		if (item.pinMissing || item.pinProjectMismatch) continue;
		if (!item.targetRoot) continue;

		const profile = linksConfig?.[item.name]?.profile;
		planned.push({
			name: item.name,
			project: item.project,
			targetRoot: item.targetRoot,
			required: item.required,
			...(profile ? { profile } : {}),
		});
	}

	return planned;
}

/**
 * Command to start one linked checkout in the background.
 * Intentionally omits `--with-links` so bidirectional links (A <-> B) cannot
 * recurse into a startup cycle.
 */
export function buildLinkedStartArgv(
	cli: CliInvocation,
	target: Pick<PlannedLinkStart, "profile">,
): string[] {
	return [
		cli.program,
		...(cli.script ? [cli.script] : []),
		"dev",
		"--detach",
		...(target.profile ? [`--profile=${target.profile}`] : []),
	];
}

/**
 * Vars scoped to one checkout or active egress guard that must never bleed
 * into a linked repo started by `dev --with-links`.
 */
const LINKED_CHILD_STRIP_ENV = [
	PORT_OFFSET_ENV,
	"BUNCARGO_APP_NAME",
	"BUNCARGO_APP_HOSTNAME",
	...EGRESS_GUARD_ENV_KEYS,
] as const;

/**
 * Child environment for starting a linked checkout: starts from
 * {@link agentAwareProcessEnv} (which already strips connect tokens and
 * `BUNCARGO_DETACHED`) and removes checkout-specific port offsets, app marks,
 * and egress proxy vars so the companion runs cleanly in its own environment.
 */
export function linkedStartEnv(
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = agentAwareProcessEnv(baseEnv);
	for (const key of LINKED_CHILD_STRIP_ENV) {
		delete env[key];
	}
	return env;
}

export interface LinkedStartResult {
	readonly target: PlannedLinkStart;
	readonly exitCode: number;
	readonly output: string;
}

export interface StartLinkedOptions {
	readonly signal?: AbortSignal;
	readonly cli?: CliInvocation;
	readonly onStart?: (target: PlannedLinkStart) => void;
	readonly onDone?: (target: PlannedLinkStart) => void;
	readonly onWarning?: (message: string) => void;
	readonly runSpawn?: (
		argv: readonly string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
	) => Promise<{ exitCode: number; output: string }>;
}

async function defaultSpawn(
	argv: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ exitCode: number; output: string }> {
	options.signal?.throwIfAborted();
	const child = Bun.spawn([...argv], {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const onAbort = () => {
		try {
			child.kill("SIGTERM");
		} catch {
			// Process already exited.
		}
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return {
			exitCode,
			output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
		};
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function outputTail(output: string, maxLines = 15): string[] {
	if (!output.trim()) return [];
	return output.trim().split("\n").slice(-maxLines);
}

/**
 * Start every planned linked checkout via `buncargo dev --detach` in its own
 * directory. Required (`before`) failures throw a {@link CliError}; optional
 * (`after`) failures report a warning so this checkout keeps running.
 */
export async function startLinkedCheckouts(
	targets: readonly PlannedLinkStart[],
	options: StartLinkedOptions = {},
): Promise<LinkedStartResult[]> {
	if (targets.length === 0) return [];
	options.signal?.throwIfAborted();

	const cli = options.cli ?? buncargoCli();
	const runSpawn = options.runSpawn ?? defaultSpawn;
	const env = linkedStartEnv();

	// Independent linked repos boot concurrently so multi-repo startup waits
	// for the slowest companion rather than their sum.
	const results = await Promise.all(
		targets.map(async (target): Promise<LinkedStartResult> => {
			options.signal?.throwIfAborted();
			options.onStart?.(target);

			const argv = buildLinkedStartArgv(cli, target);
			let outcome: { exitCode: number; output: string };
			try {
				outcome = await runSpawn(argv, {
					cwd: target.targetRoot,
					env,
					signal: options.signal,
				});
			} catch (error) {
				if (options.signal?.aborted) throw error;
				outcome = { exitCode: 1, output: getErrorMessage(error) };
			}

			if (outcome.exitCode === 0) {
				options.onDone?.(target);
			}

			return {
				target,
				exitCode: outcome.exitCode,
				output: outcome.output,
			};
		}),
	);

	for (const { target, exitCode, output } of results) {
		if (exitCode === 0) continue;

		const quotedRoot = shellQuote(target.targetRoot);
		const manualCmd = target.profile
			? `cd ${quotedRoot} && bunx buncargo dev --detach --profile=${shellQuote(target.profile)}`
			: `cd ${quotedRoot} && bunx buncargo dev --detach`;
		if (target.required) {
			throw new CliError(
				`Failed to start required linked repo "${target.name}" (${target.targetRoot}) with exit code ${exitCode}.`,
				[
					...outputTail(output),
					`Start it directly to inspect: \`${manualCmd}\``,
				],
			);
		}

		const tail = outputTail(output, 5).join("\n");
		const detail = tail ? `\n${tail}` : "";
		options.onWarning?.(
			`Could not start optional linked repo "${target.name}" (${target.targetRoot}, exit ${exitCode}). Start it manually with \`${manualCmd}\`.${detail}`,
		);
	}

	return results;
}
