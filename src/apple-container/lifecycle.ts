import {
	isContainerServing,
	isContainerStopped,
} from "../container-runtime/container-state";
import type {
	ContainerDownRequest,
	ContainerUpRequest,
} from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import {
	createPortOwnerSnapshotAsync,
	formatPortOwner,
	type PortOwnerSnapshot,
} from "../core/process";
import { formatDone, formatStep, formatWarn } from "../core/style";
import { SERVICE_HASH_LABEL } from "../docker-compose/interpolate";
import { appleContainerRuntimeAdapter } from "./adapter";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import {
	isAlreadyExistsMessage,
	isAlreadyRunningMessage,
	isMissingResourceMessage,
	runAppleAsync,
} from "./cli";
import { appleAvailabilityFromStatus } from "./preflight";
import {
	buildAppleRunPlan,
	type ContainerRunPlan,
	PROJECT_LABEL,
	projectVolumeNames,
} from "./run-plan";
import type { AppleContainerRecord } from "./status";
import { LIST_ARGS, readContainerListing, recordState } from "./status";

/**
 * Run one `container` argv against the operation's shared deadline; `stream`
 * sends its output to the terminal instead of capturing it.
 */
type AppleRun = (
	args: string[],
	options?: { stream?: true },
) => Promise<AppleCliResult>;
/** Who holds each of these ports, read once when a start fails on one. */
type PortOwnerLookup = (ports: number[]) => Promise<PortOwnerSnapshot>;

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

/**
 * Turn "port in use" into a message naming whoever holds it.
 *
 * Apple's message names no port (`bind(...): Address already in use (errno:
 * 48)`), so the candidates are the ports this container publishes.
 */
async function translatePortError(
	result: AppleCliResult,
	action: string,
	publishedPorts: number[],
	ownersOf: PortOwnerLookup,
): Promise<never> {
	const message = `${result.stderr}\n${result.stdout}`;
	if (
		/address already in use|port is already allocated|already bound/i.test(
			message,
		)
	) {
		const owners = await ownersOf(publishedPorts);
		for (const port of publishedPorts) {
			const owner = owners.owner(port);
			if (owner) throw new Error(formatPortOwner(port, owner));
		}
	}
	failed(result, action);
}

/**
 * Apple sometimes reports the container it is creating as missing, seen when
 * the same name was deleted moments before. A second `run` succeeds.
 */
function isTransientRunFailure(result: AppleCliResult): boolean {
	return /container with id .* not found/i.test(result.stderr);
}

/**
 * The size of a new named volume. Apple formats each as a sparse ext4 image,
 * and formatting its 512G default takes about a second against ~0.4s here,
 * paid by every new checkout's database. The CLI cannot grow a volume later.
 */
const VOLUME_SIZE = "256G";

async function ensureVolume(run: AppleRun, name: string): Promise<void> {
	const result = await run(["volume", "create", "-s", VOLUME_SIZE, name]);
	if (result.ok || isAlreadyExistsMessage(result.stderr)) return;
	failed(result, `create volume ${name}`);
}

async function removeContainer(
	run: AppleRun,
	containerName: string,
): Promise<void> {
	const result = await run(["delete", "--force", containerName]);
	if (result.ok || isMissingResourceMessage(result.stderr)) return;
	failed(result, `delete container ${containerName}`);
}

/**
 * Pull a missing image where the user can watch it. Inside `run` the pull is
 * silent, and a first pull of a database image takes minutes. The platform is
 * explicit because `image pull` otherwise fetches every platform the image has.
 */
async function pullIfMissing(
	run: AppleRun,
	plan: ContainerRunPlan,
): Promise<void> {
	const present = await run(["image", "inspect", plan.image]);
	if (present.ok) return;
	console.log(formatStep(`⬇️  Pulling ${plan.image}...`));
	const pulled = await run(
		["image", "pull", "--platform", plan.platform, plan.image],
		{ stream: true },
	);
	if (!pulled.ok) failed(pulled, `pull image ${plan.image}`);
}

async function startService(
	run: AppleRun,
	plan: ContainerRunPlan,
	existing: AppleContainerRecord | undefined,
	verbose: boolean,
	ownersOf: PortOwnerLookup,
): Promise<void> {
	if (existing) {
		const state = recordState(existing);
		if (existing.labels[SERVICE_HASH_LABEL] === plan.configHash) {
			if (isContainerServing(state)) return;
			const started = await run(["start", plan.containerName]);
			if (started.ok) return;
			// A container whose state Apple did not say may be running already,
			// which `start` refuses; readiness tells whether it serves. Any other
			// refusal (a port taken, a broken image) is this start's failure.
			const runsAlready =
				state === "unknown" && isAlreadyRunningMessage(started.stderr);
			if (runsAlready) return;
			if (!isMissingResourceMessage(started.stderr))
				failed(started, `start container ${plan.containerName}`);
		} else {
			// Announced even on a quiet reconcile pass: a container being thrown
			// away and rebuilt is the one thing here worth interrupting for.
			console.log(
				formatStep(`♻️  Recreating ${plan.serviceName} (config changed)`),
			);
			// Stopped first: `delete --force` kills, and the container being
			// replaced is usually a database with a volume to keep consistent.
			// Only a container known to be stopped skips it. One in a state
			// Apple did not say may refuse the stop for being stopped already,
			// which is no reason to fail.
			if (!isContainerStopped(state)) {
				const stopped = await run(["stop", plan.containerName]);
				const refused =
					!stopped.ok && !isMissingResourceMessage(stopped.stderr);
				if (refused && isContainerServing(state)) {
					failed(stopped, `stop container ${plan.containerName}`);
				}
			}
			await removeContainer(run, plan.containerName);
		}
	}

	if (verbose) await pullIfMissing(run, plan);

	// The plan already carries interpolated values, so nothing depends on the
	// child's own environment.
	let result = await run(plan.runArgs);
	if (!result.ok && isTransientRunFailure(result))
		result = await run(plan.runArgs);
	if (!result.ok) {
		await translatePortError(
			result,
			`start container ${plan.containerName}`,
			plan.publishedPorts,
			ownersOf,
		);
	}
}

async function up(
	run: AppleRun,
	request: ContainerUpRequest,
	ownersOf: PortOwnerLookup,
): Promise<void> {
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
		await ensureVolume(run, volume);
	}

	// Read the inventory once so every service in this run decides reuse against
	// the same snapshot rather than re-listing per service.
	// Output that is not JSON is no inventory: read as empty, every `run`
	// below would collide with a container that is there.
	const inventory = await run(LIST_ARGS);
	const listing = readContainerListing(inventory);
	if (!listing.listed) failed(inventory, "read container inventory");
	const existing = new Map(
		listing.records.map((record) => [record.id, record]),
	);

	for (const service of plan.services) {
		await startService(
			run,
			service,
			existing.get(service.containerName),
			verbose,
			ownersOf,
		);
	}

	if (verbose) console.log(formatDone("Containers started"));
}

async function down(
	run: AppleRun,
	request: ContainerDownRequest,
): Promise<void> {
	const { verbose = true, removeVolumes = false } = request;

	const inventory = await run(LIST_ARGS);
	const listing = readContainerListing(inventory);
	if (!inventory.ok) {
		// A stopped system service runs no containers, so there is nothing to
		// stop, as with Docker's daemon. Asked only after the listing failed,
		// to keep every other teardown at one process. A status that did not
		// answer may be a service holding every container and port here.
		// Volumes cannot be removed without it, and a reset that silently kept
		// them would not be.
		const status = await run(["system", "status"]);
		if (appleAvailabilityFromStatus(status).state !== "down")
			failed(inventory, "read container inventory");
		if (removeVolumes)
			throw new Error(
				`Apple container is not running, so the volumes of ${request.projectName} were not removed. Start it with \`container system start\`, then run again.`,
			);
		if (verbose)
			console.log(
				formatStep("ℹ Apple container is not running. Nothing to stop."),
			);
		return;
	}
	// Answered, but not with JSON: nothing here says the project is empty.
	if (!listing.listed) failed(inventory, "read container inventory");
	const records = listing.records.filter(
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
		// `delete --force` kills, so everything not known to be stopped gets a
		// graceful stop first: a container whose state Apple did not say may
		// be a database that is running.
		const running = records
			.filter((record) => isContainerServing(recordState(record)))
			.map((record) => record.id);
		const unsure = records
			.filter((record) => {
				const state = recordState(record);
				return !isContainerServing(state) && !isContainerStopped(state);
			})
			.map((record) => record.id);
		// Reporting "Containers stopped" over a failed stop would send the caller
		// away believing the ports are free.
		if (running.length > 0) {
			const stopped = await run(["stop", ...running]);
			if (!stopped.ok && !isMissingResourceMessage(stopped.stderr)) {
				failed(stopped, `stop containers ${running.join(", ")}`);
			}
		}
		// Asked apart: one that was stopped already may fail the stop, and the
		// delete below still removes it.
		if (unsure.length > 0) await run(["stop", ...unsure]);
		const removed = await run(["delete", "--force", ...ids]);
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
		// Every volume is tried, then the run fails: a reset that reported
		// success over a kept volume hands the next run the old database.
		const kept: string[] = [];
		for (const volume of projectVolumeNames(
			request.projectName,
			request.model,
		)) {
			const result = await run(["volume", "delete", volume]);
			if (!result.ok && !isMissingResourceMessage(result.stderr))
				kept.push(`${volume}: ${result.stderr.trim()}`);
		}
		if (kept.length > 0) {
			const message = `Could not remove the volumes of ${request.projectName}:\n  ${kept.join("\n  ")}\nRemove them with \`container volume delete <name>\`, or run the reset again.`;
			throw new Error(message);
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

/** One runner per operation, so every step it takes shares one deadline. */
function appleRunner(
	cli: AppleContainerCli,
	options: { signal?: AbortSignal; timeoutMs: number },
): AppleRun {
	const deadline = performance.now() + options.timeoutMs;
	return (args, { stream } = {}) => {
		options.signal?.throwIfAborted();
		if (remainingTime(deadline) === 0)
			throw new Error("Apple container operation timed out");
		return runAppleAsync(cli, args, {
			signal: options.signal,
			inherit: stream === true,
			timeoutMs: remainingTime(deadline),
		});
	};
}

export function appleUp(
	cli: AppleContainerCli,
	request: ContainerUpRequest,
): Promise<void> {
	// Asked of Apple itself: its port forwarder holds the socket, so the host
	// lookup alone names the forwarder rather than the container behind it.
	const runtime = appleContainerRuntimeAdapter({ cli });
	const ownersOf = (ports: number[]) =>
		createPortOwnerSnapshotAsync({ runtime, ports, signal: request.signal });
	const run = appleRunner(cli, {
		signal: request.signal,
		timeoutMs: request.timeoutMs ?? 600000,
	});
	return up(run, request, ownersOf);
}
export function appleDown(
	cli: AppleContainerCli,
	request: ContainerDownRequest,
): Promise<void> {
	const run = appleRunner(cli, {
		signal: request.signal,
		timeoutMs: request.timeoutMs ?? 120000,
	});
	return down(run, request);
}
