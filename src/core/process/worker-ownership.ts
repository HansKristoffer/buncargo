import type { EventEmitter } from "node:events";
import { typedSwitch } from "hanzio";
import { withFileLock } from "../file-lock";
import {
	checkProcessIdentitiesAsync,
	checkProcessIdentityAsync,
	type ProcessIdentityCheck,
	readProcessIdentityAsync,
} from "../process-identity";
import { defineListRegistry } from "../registry-file";
import { projectStateFilePath } from "../state-paths";
import type { AppChild } from "./pty-app";
import { terminateOwnedProcess, terminateProcessGroup } from "./terminate";

interface WorkerOwner {
	name: string;
	pid: number;
	identity: string;
}

const registry = defineListRegistry<WorkerOwner>({
	version: 1,
	key: "workers",
	isEntry: (value): value is WorkerOwner => {
		if (!value || typeof value !== "object") {
			return false;
		}

		const entry = value as Partial<WorkerOwner>;
		return (
			typeof entry.name === "string" &&
			Number.isInteger(entry.pid) &&
			(entry.pid ?? 0) > 1 &&
			typeof entry.identity === "string"
		);
	},
});

const pathFor = (root: string) => projectStateFilePath(root, "workers.json");

/**
 * The recorded worker of this name that may still run. One whose identity
 * cannot be read counts: reading it as gone starts a second copy.
 */
export async function findWorker(
	root: string,
	name: string,
	signal?: AbortSignal,
): Promise<WorkerOwner | undefined> {
	const entries = await registry.read(pathFor(root), { strict: true });
	const entry = entries.find((entry) => entry.name === name);
	if (!entry) return undefined;
	const check = await checkProcessIdentityAsync(
		entry.pid,
		entry.identity,
		signal,
	);
	return check === "mismatch" ? undefined : entry;
}

export type WorkerClaimDecision =
	| { kind: "claim"; standing: WorkerOwner[] }
	| {
			kind: "held";
			holder: WorkerOwner;
			check: Exclude<ProcessIdentityCheck, "mismatch">;
	  };

/**
 * Whether `name` may be claimed, given each recorded claim's identity check
 * (in the same order), and the claims that stand beside it. Ownership is
 * strict both ways: only a claim whose process is gone is dropped, and one
 * that cannot be read stands, since erasing it could start a second copy of
 * a worker that still runs.
 */
export function decideWorkerClaim(
	recorded: readonly WorkerOwner[],
	checks: readonly ProcessIdentityCheck[],
	name: string,
): WorkerClaimDecision {
	const standing = recorded.flatMap((entry, index) => {
		const check = checks[index];
		return check === "mismatch" ? [] : [{ entry, check }];
	});
	const held = standing.find(({ entry }) => entry.name === name);
	if (held) return { kind: "held", holder: held.entry, check: held.check };
	return { kind: "claim", standing: standing.map(({ entry }) => entry) };
}

/**
 * Hold the claim lock through spawn and publication so concurrent starts
 * cannot duplicate a worker.
 */
export async function spawnOwnedWorker(
	root: string,
	name: string,
	spawn: () => AppChild,
	signal?: AbortSignal,
	options: {
		/**
		 * Hand back a worker that exited before it could be claimed instead
		 * of failing: a non-essential app's crash is the supervisor's to report.
		 */
		allowEarlyExit?: boolean;
	} = {},
): Promise<AppChild> {
	const path = pathFor(root);

	return withFileLock(
		path,
		async () => {
			const recorded = await registry.read(path, { strict: true });
			const decision = decideWorkerClaim(
				recorded,
				await checkProcessIdentitiesAsync(recorded, signal),
				name,
			);
			if (decision.kind === "held") {
				const { pid } = decision.holder;
				const reason = typedSwitch(decision.check, {
					match: () => "is already running",
					unreadable: () =>
						"may still be running: its process could not be inspected",
				});
				const refusal = `Worker "${name}" (pid ${pid}) ${reason}. Reuse it through the CLI, or use dev --takeover to move it here.`;
				throw new Error(refusal);
			}
			const entries = decision.standing;

			signal?.throwIfAborted();
			const child = spawn();
			const exited = () => child.exitCode !== null || child.signalCode !== null;
			// A worker that died before it was claimed can leave its own
			// children holding the group, unowned: nothing would ever stop them.
			const handBack = async () => {
				await terminateOwnedProcess(child, 1000);
				return child;
			};

			try {
				// Observe spawn errors here until the caller attaches its supervisor.
				await new Promise<void>((resolve, reject) => {
					(child as EventEmitter).once("spawn", resolve);
					(child as EventEmitter).once("error", reject);
				});

				const identity = child.pid
					? await readProcessIdentityAsync(child.pid, signal)
					: undefined;
				if (exited() && options.allowEarlyExit) return await handBack();
				if (!child.pid || !identity || exited()) {
					throw new Error(`Worker "${name}" exited before process startup`);
				}

				await registry.write(path, [
					...entries,
					{ name, pid: child.pid, identity },
				]);

				// The child can exit while its identity is being written to disk.
				if (exited()) {
					await registry.write(path, entries);
					if (options.allowEarlyExit) return await handBack();
					throw new Error(`Worker "${name}" exited before process startup`);
				}

				signal?.throwIfAborted();
				return child;
			} catch (error) {
				// The supervisor takes ownership only when this function returns.
				await terminateOwnedProcess(child, 1000);
				throw error;
			}
		},
		{ signal },
	);
}

/** Only explicit takeover calls this, after checking the recorded birth identity. */
export async function stopWorker(root: string, name: string): Promise<boolean> {
	const path = pathFor(root);

	return withFileLock(path, async () => {
		const entries = await registry.read(path, { strict: true });
		const entry = entries.find((item) => item.name === name);
		if (!entry || !(await terminateProcessGroup(entry.pid, entry.identity)))
			return false;

		await registry.write(
			path,
			entries.filter((item) => item !== entry),
		);

		return true;
	});
}
