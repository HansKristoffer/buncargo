import { abortableSleep } from "../deadline";
import { isTcpPortOpen } from "../network";
import {
	classifyPortOccupant,
	collectProcessTree,
	createPortOwnerSnapshot,
	formatPortOwner,
	type PortOwner,
} from "./port-owner";
import {
	type ListenerSnapshot,
	readListenerSnapshotAsync,
} from "./port-snapshot";

/**
 * Noticing an app that came up on a port other than the one it was given.
 *
 * A framework that finds its port taken (Astro, Vite without `strictPort`)
 * prints "trying another one" and listens on the next port, while readiness
 * keeps asking the assigned one until it times out a minute later - and then
 * fails a run whose other apps were fine. This turns that minute into one
 * named error.
 *
 * It only reports when the assigned port is held by something that is not the
 * app: an app still booting may listen on its inspector port before its server
 * port, and that alone is not drift.
 */

export interface DriftTarget {
	name: string;
	pid: number;
	port: number;
}

export interface DriftProbe {
	listeners(signal: AbortSignal): Promise<ListenerSnapshot>;
	/** Who holds the port, when nothing in `listeners` is ours. */
	foreignHolder(
		port: number,
		listeners: ListenerSnapshot,
		signal: AbortSignal,
	): Promise<PortOwner | null>;
	processTree(pid: number): number[];
}

/** Ports the app's process tree listens on, other than its assigned one. */
export function driftedPorts(
	target: DriftTarget,
	listeners: ListenerSnapshot,
	tree: readonly number[],
): number[] {
	const members = new Set(tree);
	const ports: number[] = [];
	for (const [port, pids] of listeners.pidsByPort)
		if (port !== target.port && pids.some((pid) => members.has(pid)))
			ports.push(port);
	return ports.sort((a, b) => a - b);
}

export function formatDrift(
	target: DriftTarget,
	listening: number[],
	holder: PortOwner,
): string {
	const ports = listening.map((port) => `:${port}`).join(", ");
	return `${target.name} listens on ${ports}, not its assigned :${target.port}; ${formatPortOwner(target.port, holder)}. Run dev again to move to a free port block.`;
}

/** One pass: the first target that drifted, as an error message. */
export async function checkPortDrift(
	targets: readonly DriftTarget[],
	probe: DriftProbe,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (targets.length === 0) return undefined;
	const listeners = await probe.listeners(signal);
	for (const target of targets) {
		const holder = await probe.foreignHolder(target.port, listeners, signal);
		if (!holder) continue;
		const listening = driftedPorts(
			target,
			listeners,
			probe.processTree(target.pid),
		);
		if (listening.length > 0) return formatDrift(target, listening, holder);
	}
	return undefined;
}

export function systemDriftProbe(options: {
	root: string;
	projectName: string;
}): DriftProbe {
	return {
		listeners: (signal) => readListenerSnapshotAsync(signal),
		async foreignHolder(port, listeners, signal) {
			if ((listeners.pidsByPort.get(port)?.length ?? 0) > 0) {
				// Visible: ours (the app, or a server it detached) is no drift.
				const owner = createPortOwnerSnapshot({
					listeners,
					containers: new Map(),
					ports: [port],
				}).owner(port);
				return classifyPortOccupant(owner, options) === "fail" ? owner : null;
			}
			// Nothing listed, yet something answers: a holder `lsof` cannot show
			// this user. Connecting, never binding - a probe that bound the port
			// could itself push a booting app off it.
			return (await isTcpPortOpen(port, "127.0.0.1", 500, signal))
				? { pids: [], unidentified: true }
				: null;
		},
		processTree: collectProcessTree,
	};
}

/**
 * Poll until `signal` aborts, rejecting the moment a target drifted.
 * Resolves (never rejects) on abort, so racing it cannot mask the real result.
 */
export async function watchPortDrift(
	targets: () => readonly DriftTarget[],
	probe: DriftProbe,
	signal: AbortSignal,
	intervalMs = 1000,
): Promise<void> {
	try {
		while (!signal.aborted) {
			await abortableSleep(intervalMs, signal);
			const drift = await checkPortDrift(targets(), probe, signal);
			if (drift && !signal.aborted) throw new Error(drift);
		}
	} catch (error) {
		if (signal.aborted) return;
		throw error;
	}
}
