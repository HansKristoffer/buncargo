import {
	type ContainerRuntimeAdapter,
	describeServiceCondition,
	type ServiceChange,
	watchServiceContainers,
} from "../container-runtime";
import { explainServiceStop, readRemovals } from "../core/removal-log";
import { patchRun } from "../core/run-registry";
import { formatWarn } from "../core/style";
import { getComposeServiceName } from "../planning";
import type { ServiceConfig } from "../types";

/** Where a service change is said: `problem` is false for a recovery. */
export type ServiceChangeReport = (message: string, problem: boolean) => void;

export interface ServiceWatchApi {
	/** Watch these service keys too, from now until {@link stop}. */
	watch(serviceKeys: readonly string[]): void;
	report(report: ServiceChangeReport): void;
	stop(): void;
}

/**
 * A run's watch over its own service containers: a loud line and the
 * service's `problem` in `runs.json` when one stops, is removed or turns
 * unhealthy, so `status` stops calling the run ready.
 *
 * No restart. The cause is unknown when this fires: a deliberate
 * `buncargo stop postgres`, Docker Desktop restarting, or the runtime
 * itself failing. Starting the container again would hide the one signal
 * that explains the next failure, and race whoever stopped it.
 */
export function createServiceWatch(
	ctx: {
		readonly services: Record<string, ServiceConfig>;
		readonly projectName: string;
		readonly root: string;
		readonly runtime: Pick<
			ContainerRuntimeAdapter,
			"name" | "projectServiceStates"
		>;
	},
	sessionId: string,
): ServiceWatchApi {
	// Compose service name → service key, for the registry entry.
	const watched = new Map<string, string>();
	let report: ServiceChangeReport = (message, problem) =>
		console.warn(problem ? formatWarn(message) : message);
	let stopWatching: (() => void) | undefined;
	let watchedSince = Date.now();
	// When each service was last seen coming back: a stop before that is
	// explained already, and must not be blamed for the next one.
	const upSince = new Map<string, number>();

	const onChange = (changes: ServiceChange[]) => {
		const records = readRemovals();
		for (const change of changes) {
			const { condition } = change;
			const what = describeServiceCondition(change);
			const lost =
				condition.state === "stopped" || condition.state === "missing";
			const detail = lost
				? `${what}. ${explainServiceStop({
						projectName: ctx.projectName,
						root: ctx.root,
						runtime: ctx.runtime.name,
						service: change.service,
						since: upSince.get(change.service) ?? watchedSince,
						records,
					})}`
				: what;
			const sentence = detail.endsWith(".") ? detail : `${detail}.`;
			report(
				lost
					? `${sentence} Apps that use it fail until it is back: restart the run (\`buncargo stop --all\`, then \`buncargo dev\`).`
					: detail,
				condition.state !== "up",
			);
			if (condition.state === "up") upSince.set(change.service, Date.now());
			const name = watched.get(change.service) ?? change.service;
			void patchRun(sessionId, {
				services: [
					{
						name,
						problem:
							condition.state === "up"
								? undefined
								: {
										state: condition.state,
										detail,
										since: new Date().toISOString(),
									},
					},
				],
			}).catch(() => {});
		}
	};

	return {
		watch(serviceKeys) {
			for (const key of serviceKeys) {
				const service = ctx.services[key];
				// A job exits when it is done, and a stack's containers are its CLI's.
				if (!service || service.kind === "job" || service.external) continue;
				watched.set(getComposeServiceName(ctx.services, key), key);
			}
			if (stopWatching || watched.size === 0) return;
			watchedSince = Date.now();
			upSince.clear();
			stopWatching = watchServiceContainers({
				runtime: ctx.runtime,
				projectName: ctx.projectName,
				services: () => [...watched.keys()],
				onChange,
			});
		},
		report(next) {
			report = next;
		},
		stop() {
			stopWatching?.();
			stopWatching = undefined;
			watched.clear();
		},
	};
}
