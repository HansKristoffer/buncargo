import { arch, platform } from "node:os";
import {
	ContainerRuntimeUnavailableError,
	type RuntimeAvailability,
} from "../container-runtime/types";
import { abortableSleep, remainingTime } from "../core/deadline";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import {
	APPLE_CONTAINER_COMMAND,
	createAppleContainerCli,
	runAppleAsync,
} from "./cli";

const DISPLAY_NAME = "Apple container";

export interface EnsureAppleContainerOptions {
	signal?: AbortSignal;
	autoStart?: boolean;
	/** Whether this is CI, where a stopped service is waited for rather than started. */
	ci?: boolean;
	timeoutMs?: number;
	verbose?: boolean;
}

/** Apple's runtime is Apple silicon macOS only; nothing else can run it. */
export function isAppleContainerSupported(): boolean {
	return platform() === "darwin" && arch() === "arm64";
}

function unsupportedPlatformMessage(): string {
	return `Apple container requires macOS on Apple silicon (this host is ${platform()}/${arch()}). Use docker.runtime: "docker".`;
}

function installMessage(): string {
	return `Install it from https://github.com/apple/container, or point docker.binary / BUNCARGO_CONTAINER_BINARY at the "${APPLE_CONTAINER_COMMAND}" binary.`;
}

/** Whether this machine can run Apple's runtime and has it installed. */
export function isAppleContainerInstalled(
	cli: AppleContainerCli = createAppleContainerCli(),
): boolean {
	return isAppleContainerSupported() && cli.found;
}

/**
 * What `container system status` says. A stopped system service, an
 * unsupported machine or a missing binary runs nothing; a status that did not
 * come back in time may be a service running every container we have.
 */
export function appleContainerAvailability(
	cli: AppleContainerCli,
): RuntimeAvailability {
	if (!isAppleContainerSupported() || !cli.found) return { state: "down" };
	return appleAvailabilityFromStatus(cli.run(["system", "status"]));
}

/**
 * What one `container system status` said. Only a status that answered
 * reads as down; one cut off at its timeout may be a service running every
 * container a checkout has.
 */
export function appleAvailabilityFromStatus(
	status: AppleCliResult,
): RuntimeAvailability {
	if (status.ok) return { state: "up" };
	if (status.timedOut)
		return {
			state: "unreachable",
			detail: "Apple container did not answer in time",
		};
	return { state: "down" };
}

/**
 * What a run does about a system service that is down, as Docker does with
 * its daemon: CI never starts one but waits for one a runner is still
 * bringing up; locally it is started unless the caller said not to.
 */
export function appleStartAction(
	autoStart: boolean,
	ci: boolean,
): "start" | "wait" | "refuse" {
	if (autoStart) return "start";
	return ci ? "wait" : "refuse";
}

const START_REMEDIATION = `Run \`${APPLE_CONTAINER_COMMAND} system start\` and try again, or set docker.runtime: "docker".`;

/**
 * What fixes a `container system start` that failed. A machine that never
 * ran the runtime has no kernel, and the start stops at the prompt that
 * offers one: that needs the command run once in a terminal, which no retry
 * of ours replaces.
 */
export function appleStartFailureRemediation(started: AppleCliResult): string {
	const detail = started.stderr.trim();
	const lastError = detail ? ` Last error: ${detail}` : "";
	const noKernel = /kernel/i.test(`${started.stderr}\n${started.stdout}`);
	if (noKernel)
		return `Apple container has no kernel installed yet. Run \`${APPLE_CONTAINER_COMMAND} system start\` once in a terminal, which asks before installing one, then try again; or set docker.runtime: "docker".${lastError}`;
	return `${START_REMEDIATION}${lastError}`;
}

/**
 * Bring the Apple container services up, or explain how to.
 *
 * Auto-start deliberately does not pass `--enable-kernel-install`: on a host
 * that has never run the runtime, that flag would install a kernel without
 * asking, and without it the command prompts and would hang a non-interactive
 * spawn. Both are worse than telling the user to run the one-time setup.
 */
export async function ensureAppleContainerRunning(
	cli: AppleContainerCli,
	options: EnsureAppleContainerOptions = {},
): Promise<void> {
	const {
		ci = isCI(),
		autoStart = !ci,
		timeoutMs = 60_000,
		verbose = true,
	} = options;

	if (!isAppleContainerSupported()) {
		throw new ContainerRuntimeUnavailableError(
			"apple",
			DISPLAY_NAME,
			unsupportedPlatformMessage(),
		);
	}

	const { signal } = options;
	const deadline = performance.now() + timeoutMs;
	const running = async () =>
		(
			await runAppleAsync(cli, ["system", "status"], {
				signal,
				timeoutMs: Math.min(5000, remainingTime(deadline)),
			})
		).ok;
	if (await running()) return;

	if (!cli.found) {
		throw new ContainerRuntimeUnavailableError(
			"apple",
			DISPLAY_NAME,
			installMessage(),
		);
	}

	const action = appleStartAction(autoStart, ci);
	if (action === "refuse") {
		throw new ContainerRuntimeUnavailableError(
			"apple",
			DISPLAY_NAME,
			START_REMEDIATION,
		);
	}

	let started: AppleCliResult | undefined;
	if (action === "start") {
		if (verbose) {
			console.log(
				formatStep("📦 Apple container is not running. Starting services..."),
			);
		}
		started = await runAppleAsync(cli, ["system", "start", "--timeout", "30"], {
			signal,
			timeoutMs: Math.min(30000, remainingTime(deadline)),
		});
		// A start that failed (on a machine never set up, it stops at the
		// kernel prompt) will not come up by waiting: say so now, not after
		// the timeout.
		if (!started.ok && !(await running())) {
			throw new ContainerRuntimeUnavailableError(
				"apple",
				DISPLAY_NAME,
				appleStartFailureRemediation(started),
			);
		}
	}

	while (remainingTime(deadline) > 0) {
		if (await running()) {
			if (verbose) console.log(formatDone("Apple container is ready"));
			return;
		}
		await abortableSleep(Math.min(1000, remainingTime(deadline)), signal);
		if (verbose) {
			const elapsed = Math.round((timeoutMs - remainingTime(deadline)) / 1000);
			console.log(formatWait(`Waiting for Apple container... (${elapsed}s)`));
		}
	}

	throw new ContainerRuntimeUnavailableError(
		"apple",
		DISPLAY_NAME,
		started ? appleStartFailureRemediation(started) : START_REMEDIATION,
	);
}
