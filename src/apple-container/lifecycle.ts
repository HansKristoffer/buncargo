import type {
	ContainerDownRequest,
	ContainerUpRequest,
} from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import { formatPortOwner, getPortOwner } from "../core/process";
import { formatDone, formatStep, formatWarn } from "../core/style";
import type { AppleCliOptions, AppleCliResult, AppleContainerCli } from "./cli";
import {
	isAlreadyExistsMessage,
	isMissingResourceMessage,
	runAppleAsync,
} from "./cli";
import {
	buildAppleRunPlan,
	CONFIG_HASH_LABEL,
	type ContainerRunPlan,
	PROJECT_LABEL,
	projectVolumeNames,
} from "./run-plan";
import type { AppleContainerRecord } from "./status";
import { isRunningState, parseContainerRecords } from "./status";

type AppleSteps = Generator<string[], void, AppleCliResult>;

/**
 * Starting and stopping a project's containers on Apple's runtime.
 *
 * Compose collapses this into `up`/`down`; here each step is explicit, which
 * is also why reuse is decided per container: an existing container that still
 * matches its config is started rather than recreated, so a second `dev` run
 * does not throw away a database volume's warm state.
 */

function failed(result: AppleCliResult, action: string): never {
	const detail = result.stderr.trim() || result.stdout.trim();
	throw new Error(
		`${action} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
	);
}

/** Turn "port in use" into a message naming whoever holds it. */
function translatePortError(result: AppleCliResult, action: string): never {
	const message = `${result.stderr}\n${result.stdout}`;
	if (
		/address already in use|port is already allocated|already bound/i.test(
			message,
		)
	) {
		const portMatch = message.match(/:(\d{2,5})\b/);
		const port = portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : undefined;
		if (port !== undefined) {
			throw new Error(
				formatPortOwner(port, getPortOwner(port) ?? { pids: [] }),
			);
		}
	}
	failed(result, action);
}

function* ensureVolume(name: string): AppleSteps {
	const result = yield ["volume", "create", name];
	if (result.ok || isAlreadyExistsMessage(result.stderr)) return;
	failed(result, `create volume ${name}`);
}

function* removeContainer(containerName: string): AppleSteps {
	const result = yield ["delete", "--force", containerName];
	if (result.ok || isMissingResourceMessage(result.stderr)) return;
	failed(result, `delete container ${containerName}`);
}

function* startService(
	plan: ContainerRunPlan,
	existing: AppleContainerRecord | undefined,
): AppleSteps {
	if (existing) {
		if (existing.labels[CONFIG_HASH_LABEL] === plan.configHash) {
			if (isRunningState(existing.state)) return;
			const started = yield ["start", plan.containerName];
			if (started.ok) return;
			if (!isMissingResourceMessage(started.stderr)) {
				failed(started, `start container ${plan.containerName}`);
			}
		} else {
			// Announced even on a quiet reconcile pass: a container being thrown
			// away and rebuilt is the one thing here worth interrupting for.
			console.log(
				formatStep(`♻️  Recreating ${plan.serviceName} (config changed)`),
			);
			yield* removeContainer(plan.containerName);
		}
	}

	// The plan already carries interpolated values, so nothing depends on the
	// child's own environment.
	const result = yield plan.runArgs;
	if (!result.ok) {
		translatePortError(result, `start container ${plan.containerName}`);
	}
}

function* upSteps(request: ContainerUpRequest): AppleSteps {
	const { verbose = true } = request;
	const plan = buildAppleRunPlan({
		projectName: request.projectName,
		model: request.model,
		root: request.root,
		env: request.envVars,
		serviceNames: request.serviceNames,
	});

	if (verbose) console.log(formatStep("📦 Starting Apple containers..."));

	// Gated on verbose so the reconcile pass over already-running services does
	// not repeat it on every command that touches the environment.
	if (verbose && plan.unsupportedKeys.length > 0) {
		console.warn(
			formatWarn(
				`Apple container ignores these compose keys: ${plan.unsupportedKeys.join(", ")}. Use docker.runtime: "docker" if you need them.`,
			),
		);
	}

	for (const volume of plan.volumes) {
		yield* ensureVolume(volume);
	}

	// Read the inventory once so every service in this run decides reuse against
	// the same snapshot rather than re-listing per service.
	const inventory = yield ["ls", "--all", "--format", "json"];
	if (!inventory.ok) failed(inventory, "read container inventory");
	const existing = new Map(
		parseContainerRecords(inventory.stdout).map((record) => [
			record.id,
			record,
		]),
	);

	for (const service of plan.services) {
		yield* startService(service, existing.get(service.containerName));
	}

	if (verbose) console.log(formatDone("Containers started"));
}

function* downSteps(request: ContainerDownRequest): AppleSteps {
	const { verbose = true, removeVolumes = false } = request;

	const inventory = yield ["ls", "--all", "--format", "json"];
	if (!inventory.ok) failed(inventory, "read container inventory");
	const records = parseContainerRecords(inventory.stdout).filter(
		(record) => record.labels[PROJECT_LABEL] === request.projectName,
	);
	if (records.length === 0 && !removeVolumes) {
		if (verbose) console.log(formatStep("ℹ No Apple containers to stop."));
		return;
	}

	if (verbose) {
		console.log(
			formatStep(
				removeVolumes
					? "🗑️  Stopping containers and removing volumes..."
					: "🛑 Stopping containers...",
			),
		);
	}

	const ids = records.map((record) => record.id);
	if (ids.length > 0) {
		const running = records
			.filter((record) => isRunningState(record.state))
			.map((record) => record.id);
		// Reporting "Containers stopped" over a failed stop would send the caller
		// away believing the ports are free.
		if (running.length > 0) {
			const stopped = yield ["stop", ...running];
			if (!stopped.ok && !isMissingResourceMessage(stopped.stderr)) {
				failed(stopped, `stop containers ${running.join(", ")}`);
			}
		}
		const removed = yield ["delete", "--force", ...ids];
		if (!removed.ok && !isMissingResourceMessage(removed.stderr)) {
			failed(removed, `delete containers ${ids.join(", ")}`);
		}
	}

	if (removeVolumes) {
		if (!request.model) {
			throw new Error(
				"Cannot remove volumes without the compose model: their names are derived from it.",
			);
		}
		for (const volume of projectVolumeNames(
			request.projectName,
			request.model,
		)) {
			const result = yield ["volume", "delete", volume];
			if (!result.ok && !isMissingResourceMessage(result.stderr)) {
				console.warn(
					formatWarn(
						`Could not remove volume ${volume}: ${result.stderr.trim()}`,
					),
				);
			}
		}
	}

	if (verbose) console.log(formatDone("Containers stopped"));
}

export function appleStopByIds(cli: AppleContainerCli, ids: string[]): void {
	if (ids.length === 0) return;
	const result = cli.run(["stop", ...ids], { inherit: true });
	// Same reason as in `appleDown`: reporting success over a failed stop tells
	// the caller the ports are free when they are not.
	if (!result.ok && !isMissingResourceMessage(result.stderr)) {
		failed(result, `stop containers ${ids.join(", ")}`);
	}
}

function runSteps(
	cli: AppleContainerCli,
	steps: AppleSteps,
	options: AppleCliOptions,
): void {
	let step = steps.next();
	while (!step.done) step = steps.next(cli.run(step.value, options));
}

async function runStepsAsync(
	cli: AppleContainerCli,
	steps: AppleSteps,
	options: AppleCliOptions,
): Promise<void> {
	const deadline = performance.now() + (options.timeoutMs ?? 600000);
	let step = steps.next();
	while (!step.done) {
		options.signal?.throwIfAborted();
		if (remainingTime(deadline) === 0)
			throw new Error("Apple container operation timed out");
		const result = await runAppleAsync(cli, step.value, {
			...options,
			timeoutMs: remainingTime(deadline),
		});
		step = steps.next(result);
	}
}

export function appleUp(
	cli: AppleContainerCli,
	request: ContainerUpRequest,
): void {
	runSteps(cli, upSteps(request), {
		signal: request.signal,
		timeoutMs: request.timeoutMs ?? 600000,
	});
}
export function appleUpAsync(
	cli: AppleContainerCli,
	request: ContainerUpRequest,
): Promise<void> {
	return runStepsAsync(cli, upSteps(request), {
		signal: request.signal,
		timeoutMs: request.timeoutMs ?? 600000,
	});
}
export function appleDown(
	cli: AppleContainerCli,
	request: ContainerDownRequest,
): void {
	runSteps(cli, downSteps(request), {
		signal: request.signal,
		timeoutMs: request.timeoutMs ?? 120000,
	});
}
export function appleDownAsync(
	cli: AppleContainerCli,
	request: ContainerDownRequest,
): Promise<void> {
	return runStepsAsync(cli, downSteps(request), {
		signal: request.signal,
		timeoutMs: request.timeoutMs ?? 120000,
	});
}
