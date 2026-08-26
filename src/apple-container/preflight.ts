import { arch, platform } from "node:os";
import { ContainerRuntimeUnavailableError } from "../container-runtime/types";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import { sleep } from "../core/utils";
import type { AppleContainerCli } from "./cli";
import { APPLE_CONTAINER_COMMAND } from "./cli";

const DISPLAY_NAME = "Apple container";

export interface EnsureAppleContainerOptions {
	autoStart?: boolean;
	timeoutMs?: number;
	verbose?: boolean;
}

/** Apple's runtime is Apple silicon macOS only; nothing else can run it. */
export function isAppleContainerSupported(): boolean {
	return platform() === "darwin" && arch() === "arm64";
}

export function unsupportedPlatformMessage(): string {
	return `Apple container requires macOS on Apple silicon (this host is ${platform()}/${arch()}). Use docker.runtime: "docker".`;
}

function installMessage(): string {
	return `Install it from https://github.com/apple/container, or point docker.binary / BUNCARGO_CONTAINER_BINARY at the "${APPLE_CONTAINER_COMMAND}" binary.`;
}

export function isAppleContainerSystemRunning(cli: AppleContainerCli): boolean {
	if (!isAppleContainerSupported()) return false;
	return cli.run(["system", "status"]).ok;
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
	const { autoStart = !isCI(), timeoutMs = 60_000, verbose = true } = options;

	if (!isAppleContainerSupported()) {
		throw new ContainerRuntimeUnavailableError(
			"apple",
			DISPLAY_NAME,
			unsupportedPlatformMessage(),
		);
	}

	if (isAppleContainerSystemRunning(cli)) return;

	if (!cli.found) {
		throw new ContainerRuntimeUnavailableError(
			"apple",
			DISPLAY_NAME,
			installMessage(),
		);
	}

	const remediation = `Run \`${APPLE_CONTAINER_COMMAND} system start\` and try again.`;
	if (!autoStart) {
		throw new ContainerRuntimeUnavailableError(
			"apple",
			DISPLAY_NAME,
			remediation,
		);
	}

	if (verbose) {
		console.log(
			formatStep("📦 Apple container is not running. Starting services..."),
		);
	}
	const started = cli.run(["system", "start", "--timeout", "30"]);

	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (isAppleContainerSystemRunning(cli)) {
			if (verbose) console.log(formatDone("Apple container is ready"));
			return;
		}
		await sleep(1000);
		if (verbose) {
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			console.log(formatWait(`Waiting for Apple container... (${elapsed}s)`));
		}
	}

	throw new ContainerRuntimeUnavailableError(
		"apple",
		DISPLAY_NAME,
		started.stderr.trim()
			? `${remediation} Last error: ${started.stderr.trim()}`
			: remediation,
	);
}
