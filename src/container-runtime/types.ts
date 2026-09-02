import type { ComposeDocument } from "../docker-compose";
import type {
	BuncargoContainer,
	ContainerRuntimeName,
	PortContainerOwner,
} from "../types";

/** Options for bringing the runtime's own daemon/services up. */
export interface EnsureRuntimeOptions {
	autoStart?: boolean;
	timeoutMs?: number;
	verbose?: boolean;
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
	root: string;
	projectName: string;
	envVars: Record<string, string>;
	model: ComposeDocument;
	/** Compose service names to start, already resolved from the service keys. */
	serviceNames: string[];
	composeFile?: string;
	verbose?: boolean;
	/** Block until the runtime itself reports readiness, where supported. */
	wait?: boolean;
}

export interface ContainerDownRequest {
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
	composeFile?: string;
}

export interface ServiceDiagnosisRequest {
	projectName: string;
	serviceName: string;
	root?: string;
	composeFile?: string;
	/** Lines of container output to collect. Default: 20. */
	tail?: number;
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
 * States that mean the container is gone rather than still coming up.
 *
 * Matched positively, so a state neither backend has shown us yet keeps the
 * readiness loop polling instead of aborting a startup that would have worked.
 */
const TERMINAL_STATES = new Set([
	"exited",
	"dead",
	"stopped",
	"removing",
	"error",
	"failed",
]);

export function isTerminalContainerState(state: string): boolean {
	return TERMINAL_STATES.has(state.trim().toLowerCase());
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
	running: boolean;
	/**
	 * The `buncargo.stack-hash` label, absent on a container created before
	 * the label existed. Absent means "cannot compare", never "does not match".
	 */
	stackHash?: string;
	/**
	 * Whether the runtime's own healthcheck currently passes.
	 *
	 * `undefined` where the runtime does not run one — a service with no
	 * healthcheck, or a backend with no concept of it. Absent means "cannot
	 * tell", never "unhealthy".
	 */
	healthy?: boolean;
}

/**
 * The single seam between buncargo and a container backend.
 *
 * Everything above this line (readiness polling, health checks, the CLI
 * inspect commands, the watchdog) is runtime-neutral; everything below it is
 * one backend's command construction.
 */
export interface ContainerRuntimeAdapter {
	readonly name: ContainerRuntimeName;
	readonly displayName: string;
	/** The binary exists and its daemon answers. Never throws. */
	isAvailable(): boolean;
	/** Start the runtime's daemon when allowed, or throw with remediation. */
	ensureRunning(options?: EnsureRuntimeOptions): Promise<void>;
	up(request: ContainerUpRequest): void;
	down(request: ContainerDownRequest): void;
	areServicesRunning(
		projectName: string,
		serviceNames: string[],
	): Promise<boolean>;
	/** Run a command in a service container; false for any failure. */
	execInService(request: ExecInServiceRequest): boolean;
	/**
	 * State and recent output for one service, or undefined when the runtime
	 * has no container for it. Never throws: this only enriches diagnostics.
	 */
	diagnoseService(
		request: ServiceDiagnosisRequest,
	): ServiceDiagnosis | undefined;
	/** Every buncargo-labeled container this runtime knows about. */
	list(): BuncargoContainer[];
	stopByIds(ids: string[]): void;
	findContainerOnPort(port: number): PortContainerOwner | undefined;
	/**
	 * Every published host port this runtime is holding, in one call.
	 *
	 * The batch form of {@link ContainerRuntimeAdapter.findContainerOnPort}. A
	 * dev run asks about every service and app port, and answering each with
	 * its own listing was most of the runtime calls a startup made.
	 */
	containerPortOwners(): Map<number, PortContainerOwner>;
	/**
	 * State of every container this runtime has for the project, in one call.
	 *
	 * Never throws: a runtime that cannot answer returns nothing, which reads
	 * as "reconcile", so a failure here costs a redundant `up` rather than a
	 * skipped one.
	 */
	projectServiceStates(projectName: string): ServiceRuntimeState[];
}

/** Thrown when the selected runtime cannot be used, with a fix in the message. */
export class ContainerRuntimeUnavailableError extends Error {
	readonly runtime: ContainerRuntimeName;
	readonly remediation: string;

	constructor(
		runtime: ContainerRuntimeName,
		displayName: string,
		remediation: string,
	) {
		super(`${displayName} is not running. ${remediation}`);
		this.name = "ContainerRuntimeUnavailableError";
		this.runtime = runtime;
		this.remediation = remediation;
	}
}
