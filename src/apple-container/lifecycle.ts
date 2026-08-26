import type {
	ContainerDownRequest,
	ContainerUpRequest,
} from "../container-runtime/types";
import { formatPortOwner, getPortOwner } from "../core/process";
import { formatDone, formatStep, formatWarn } from "../core/style";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import { isAlreadyExistsMessage, isMissingResourceMessage } from "./cli";
import {
	buildAppleRunPlan,
	CONFIG_HASH_LABEL,
	type ContainerRunPlan,
	projectVolumeNames,
} from "./run-plan";
import type { AppleContainerRecord } from "./status";
import { isRunningState, listContainerRecords, projectRecords } from "./status";

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

function ensureVolume(cli: AppleContainerCli, name: string): void {
	const result = cli.run(["volume", "create", name]);
	if (result.ok || isAlreadyExistsMessage(result.stderr)) return;
	failed(result, `create volume ${name}`);
}

function removeContainer(cli: AppleContainerCli, containerName: string): void {
	const result = cli.run(["delete", "--force", containerName]);
	if (result.ok || isMissingResourceMessage(result.stderr)) return;
	failed(result, `delete container ${containerName}`);
}

function startService(
	cli: AppleContainerCli,
	plan: ContainerRunPlan,
	existing: AppleContainerRecord | undefined,
): void {
	if (existing) {
		if (existing.labels[CONFIG_HASH_LABEL] === plan.configHash) {
			if (isRunningState(existing.state)) return;
			const started = cli.run(["start", plan.containerName]);
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
			removeContainer(cli, plan.containerName);
		}
	}

	// The plan already carries interpolated values, so nothing depends on the
	// child's own environment.
	const result = cli.run(plan.runArgs);
	if (!result.ok) {
		translatePortError(result, `start container ${plan.containerName}`);
	}
}

export function appleUp(
	cli: AppleContainerCli,
	request: ContainerUpRequest,
): void {
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
		ensureVolume(cli, volume);
	}

	// Read the inventory once so every service in this run decides reuse against
	// the same snapshot rather than re-listing per service.
	const existing = new Map(
		listContainerRecords(cli).map((record) => [record.id, record]),
	);

	for (const service of plan.services) {
		startService(cli, service, existing.get(service.containerName));
	}

	if (verbose) console.log(formatDone("Containers started"));
}

export function appleDown(
	cli: AppleContainerCli,
	request: ContainerDownRequest,
): void {
	const { verbose = true, removeVolumes = false } = request;

	const records = projectRecords(cli, request.projectName);
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
			const stopped = cli.run(["stop", ...running]);
			if (!stopped.ok && !isMissingResourceMessage(stopped.stderr)) {
				failed(stopped, `stop containers ${running.join(", ")}`);
			}
		}
		const removed = cli.run(["delete", "--force", ...ids]);
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
			const result = cli.run(["volume", "delete", volume]);
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
