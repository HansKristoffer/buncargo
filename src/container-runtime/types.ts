import type { ComposeDocument } from "../docker-compose";
import type { BuncargoVolume, ContainerRuntimeName } from "../types";
import type { ContainerState } from "./container-state";

/** Options for bringing the runtime's own daemon/services up. */
export interface EnsureRuntimeOptions {
	signal?: AbortSignal;

	autoStart?: boolean;
	/**
	 * `docker.startCommand`: how to start a daemon this backend has no start
	 * command for. Docker only; Apple's runtime starts its own service.
	 */
	startCommand?: string;
	timeoutMs?: number;
	verbose?: boolean;
	/**
	 * Kill and restart a runtime that is running but does not answer
	 * (`doctor --fix`). Docker Desktop only; other runtimes ignore it.
	 */
	forceRestartUnresponsive?: boolean;
}

/**
 * Everything a backend needs to start a service subset.
 *
 * Both the compose file and the in-memory model are carried because they are
 * the same artifact seen two ways: Docker hands the file to `docker compose`,
 * Apple walks the model to build one `container run` per service. Deriving the
 * model separately per backend would let the two drift.
 */
export interface ContainerUpRequest {
	/** Dependencies have already been prepared by an earlier startup phase. */
	noDeps?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;

	root: string;
	projectName: string;
	envVars: Record<string, string>;
	model: ComposeDocument;
	/** Compose service names to start, already resolved from the service keys. */
	serviceNames: string[];
	composeFile?: string;
	verbose?: boolean;
}

export interface ContainerDownRequest {
	signal?: AbortSignal;
	timeoutMs?: number;

	root: string;
	projectName: string;
	/**
	 * Only needed to name the volumes `removeVolumes` deletes.
	 *
	 * Containers are found by label, so the detached watchdog runner can tear a
	 * project down without loading its config.
	 */
	model?: ComposeDocument;
	composeFile?: string;
	removeVolumes?: boolean;
	verbose?: boolean;
}

export interface ExecInServiceRequest {
	signal?: AbortSignal;
	timeoutMs?: number;

	projectName: string;
	serviceName: string;
	/**
	 * Argv to run inside the service container, not a shell command line.
	 *
	 * Both backends pass this straight through, so there is no quoting step and
	 * no shell to disagree about between them.
	 */
	command: string[];
	root?: string;
}

export interface ServiceDiagnosisRequest {
	signal?: AbortSignal;
	timeoutMs?: number;
	projectName: string;
	serviceName: string;
	root?: string;
	/** Lines of container output to collect. Default: 20. */
	tail?: number;
}

/** The last output of one container, by the id its listing gave. */
export interface ContainerLogsRequest {
	signal?: AbortSignal;
	timeoutMs?: number;
	id: string;
	/** Lines of output to collect. */
	tail: number;
	root?: string;
}

/** How a service container is doing, for reporting a failed startup. */
export interface ServiceDiagnosis {
	/** The runtime's own word for the state: "running", "exited", "stopped". */
	state: string;
	exitCode?: number;
	/**
	 * The container's own last output, or empty when the runtime won't say.
	 *
	 * Only ever added to an error message, so a backend that cannot produce it
	 * degrades to a less detailed failure rather than a missed one.
	 */
	logTail: string;
}

/**
 * What a runtime knows about one of a project's service containers.
 *
 * Read in a single call for the whole project, because the questions a startup
 * asks — is everything up, and was it created from this config — used to cost
 * one runtime invocation per service each.
 */
export interface ServiceRuntimeState {
	/** Compose service name, from the `buncargo.service` label. */
	service: string;
	state: ContainerState;
	/** `isContainerServing(state)`, for readers that ask only that. */
	serving: boolean;
	/**
	 * Fingerprint of this service and its referenced top-level definitions.
	 * Absent means "cannot compare", never "does not match".
	 */
	serviceHash?: string;
	/**
	 * Whether the runtime's own healthcheck currently passes.
	 *
	 * `undefined` where the runtime does not run one — a service with no
	 * healthcheck, or a backend with no concept of it. Absent means "cannot
	 * tell", never "unhealthy".
	 */
	healthy?: boolean;
	/** A stopped container's exit code, where the runtime reports one. */
	exitCode?: number;
}

/** The labels buncargo reads, in buncargo's words rather than a backend's. */
export interface ContainerLabels {
	/** The Compose project, or Apple's project label. */
	composeProject?: string;
	/** `buncargo.project`: absent on a container buncargo did not create. */
	project?: string;
	/** `buncargo.root`: the checkout that created it. */
	root?: string;
	worktree?: string;
	/**
	 * `buncargo.service`, the Compose service name. Absent on a one-off
	 * `compose run` container, which is not the service's replica.
	 */
	service?: string;
	serviceHash?: string;
}

export interface RuntimeContainer {
	id: string;
	name: string;
	state: ContainerState;
	/** The runtime's own word for the state: "running", "exited", "stopped". */
	runtimeState: string;
	/** The runtime's human-readable status line, for display only. */
	status: string;
	exitCode?: number;
	/** The runtime's healthcheck verdict; absent means "cannot tell". */
	healthy?: boolean;
	/** Every host port it publishes, ranges expanded. */
	ports: number[];
	/**
	 * The container port behind a published host port, where it differs or
	 * the runtime says. A host port missing here maps to the same number.
	 */
	targetPorts?: Record<number, number>;
	/** Its own address on the runtime's network, where the runtime reports one. */
	address?: string;
	/** The published ports as the runtime prints them, for display. */
	portsText: string;
	labels: ContainerLabels;
}

/** A container as `buncargo prune --project` reads it. */
export interface ComposeProjectContainer {
	id: string;
	/** Compose's `com.docker.compose.project` label. */
	project: string;
	/** `isContainerLive`: anything but stopped, so running, paused, restarting. */
	running: boolean;
	/** The `buncargo.root` label: the checkout that started it, or empty. */
	root: string;
}

/** A volume or network as `buncargo prune --project` reads it. */
export interface ComposeProjectResource {
	name: string;
	project: string;
}

/** Everything a runtime holds that carries a Compose project label. */
export interface ComposeProjectResources {
	containers: ComposeProjectContainer[];
	volumes: ComposeProjectResource[];
	networks: ComposeProjectResource[];
}

export type ComposeProjectResourceKind = "container" | "volume" | "network";

/**
 * What asking a runtime's daemon told us.
 *
 * `down` and `unreachable` both mean "cannot use it now", but only `down`
 * means no container is running: a stopped daemon, or no runtime installed.
 * A daemon that refuses this user, or does not answer in time, may be
 * running every container a checkout has, so nothing may be read as stopped,
 * idle or torn down on its word.
 */
export type RuntimeAvailability =
	| { state: "up" }
	| { state: "down" }
	| { state: "unreachable"; detail: string };

/**
 * What a backend cannot do, said in one place.
 *
 * A caller that needs one of these reads it here, never the backend's name,
 * an absent member or a field left undefined.
 */
export interface RuntimeCapabilities {
	/**
	 * It reports a stopped container's exit code reliably, so a finite `job`
	 * can be verified. Apple: not yet.
	 */
	readonly jobExitCodes: boolean;
	/**
	 * Connecting to a published host port proves the service listens. Apple:
	 * its port forwarder accepts first, so a `tcp` check connects to the
	 * container's own `address` instead.
	 */
	readonly hostPortProbe: boolean;
	/**
	 * It records a Compose project on volumes and networks, which
	 * `buncargo prune --project` and the sweep trace a checkout by. Apple: no.
	 */
	readonly composeProjectResources: boolean;
}

/**
 * The single seam between buncargo and a container backend.
 *
 * Everything above this line (readiness polling, health checks, the CLI
 * inspect commands, the watchdog) is runtime-neutral; everything below it is
 * one backend's command construction. Service states, port owners, the
 * inventory and a service's diagnosis are projections of `containers()`, in
 * `containers.ts`.
 */
export interface ContainerRuntimeAdapter {
	readonly name: ContainerRuntimeName;
	readonly displayName: string;
	readonly capabilities: RuntimeCapabilities;
	/**
	 * Whether the daemon answers, and if not, whether that means nothing
	 * runs. Never throws.
	 */
	availability(): RuntimeAvailability;
	/** Start the runtime's daemon when allowed, or throw with remediation. */
	ensureRunning(options?: EnsureRuntimeOptions): Promise<void>;
	/**
	 * Every container this runtime holds, buncargo's or not, in one call.
	 * Throws when the runtime cannot answer, so an empty list means it holds
	 * none: the service watch reports that as removed, and must never report
	 * it over a daemon that did not answer.
	 */
	containers(signal?: AbortSignal): Promise<RuntimeContainer[]>;
	/**
	 * A container's last output, stdout and stderr together, or empty when the
	 * runtime won't say. Never throws: it only enriches a failure message.
	 */
	logs(request: ContainerLogsRequest): Promise<string>;
	up(request: ContainerUpRequest): Promise<void>;
	/**
	 * Stop and remove the project's containers.
	 *
	 * Must work with nothing but the project name: the sweep tears down stacks
	 * whose checkout, and with it the compose file, is already gone.
	 */
	down(request: ContainerDownRequest): Promise<void>;
	/** Stop containers by id, keeping them. Throws when one could not be stopped. */
	stop(ids: string[]): Promise<void>;
	/** Run a command in a service container; false for any failure. */
	exec(request: ExecInServiceRequest): Promise<boolean>;
	/**
	 * The argv that runs `command` in the service's container on the caller's
	 * own stdio (`-i`, plus `-t` for a terminal), for `buncargo sql`. The
	 * caller spawns it; undefined when the service has no running container.
	 */
	execArgv(
		request: Omit<ExecInServiceRequest, "timeoutMs"> & { tty: boolean },
	): Promise<string[] | undefined>;
	/**
	 * Every volume this runtime holds, for `buncargo prune`.
	 *
	 * Not scoped to buncargo: a volume carries no marker of ours, so the
	 * caller attributes them by Compose project instead. Throws when the
	 * runtime cannot answer: an empty list means it holds none.
	 */
	listVolumes(): Promise<BuncargoVolume[]>;
	/**
	 * Each volume's size on disk in bytes, for `doctor`. A volume missing from
	 * the map could not be measured; Apple container measures none. Slow on
	 * Docker (it walks every volume), so read it only when a size is shown.
	 * Throws when the runtime cannot answer.
	 */
	volumeSizes(): Promise<ReadonlyMap<string, number>>;
	/** Remove volumes by name. Returns what could not be removed, and why. */
	removeVolumes(names: string[]): Promise<{ name: string; error: string }[]>;
	/**
	 * Every Compose-labelled container, volume and network, for
	 * `buncargo prune --project`. Throws when the runtime cannot answer, since
	 * a partial listing makes the rest look disposable, and where
	 * `capabilities.composeProjectResources` is false.
	 */
	listComposeProjectResources(): Promise<ComposeProjectResources>;
	/**
	 * Remove one, without force: the runtime refuses a running container and
	 * a volume or network still in use. Returns why it was refused.
	 */
	removeComposeProjectResource(
		kind: ComposeProjectResourceKind,
		name: string,
	): Promise<string | undefined>;
}

/** Thrown when the selected runtime cannot be used, with a fix in the message. */
export class ContainerRuntimeUnavailableError extends Error {
	readonly runtime: ContainerRuntimeName;
	readonly remediation: string;

	constructor(
		runtime: ContainerRuntimeName,
		displayName: string,
		remediation: string,
		/** What is wrong, when it is more than "not running". */
		problem = `${displayName} is not running.`,
	) {
		super(`${problem} ${remediation}`);
		this.name = "ContainerRuntimeUnavailableError";
		this.runtime = runtime;
		this.remediation = remediation;
	}
}
