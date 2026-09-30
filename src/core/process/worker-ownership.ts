import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { withFileLock } from "../file-lock";
import {
	matchesProcessIdentityAsync,
	readProcessIdentitiesAsync,
	readProcessIdentityAsync,
} from "../process-identity";
import { defineListRegistry } from "../registry-file";
import { STATE_DIRNAME } from "../state-paths";
import { terminateOwnedProcess } from "./terminate";

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

const pathFor = (root: string) => join(root, STATE_DIRNAME, "workers.json");

export async function findWorker(
	root: string,
	name: string,
	signal?: AbortSignal,
): Promise<WorkerOwner | undefined> {
	const entries = await registry.read(pathFor(root), { strict: true });
	const entry = entries.find((entry) => entry.name === name);
	return entry &&
		(await matchesProcessIdentityAsync(entry.pid, entry.identity, signal))
		? entry
		: undefined;
}

/**
 * Hold the claim lock through spawn and publication so concurrent starts
 * cannot duplicate a worker.
 */
export async function spawnOwnedWorker(
	root: string,
	name: string,
	spawn: () => ChildProcess,
	signal?: AbortSignal,
): Promise<ChildProcess> {
	const path = pathFor(root);

	return withFileLock(
		path,
		async () => {
			const recorded = await registry.read(path, { strict: true });
			// Ownership is strict: an unreadable birth identity cannot grant a claim.
			const identities = await readProcessIdentitiesAsync(
				recorded.map((entry) => entry.pid),
				signal,
			);
			const live = await Promise.all(
				recorded.map(async (entry) => ({
					entry,
					matches: entry.identity.startsWith("v2:")
						? identities.get(entry.pid) === entry.identity
						: await matchesProcessIdentityAsync(
								entry.pid,
								entry.identity,
								signal,
							),
				})),
			);
			const entries = live
				.filter((item) => item.matches)
				.map((item) => item.entry);

			if (entries.some((entry) => entry.name === name)) {
				throw new Error(
					`Worker "${name}" is already running. Reuse it through the CLI, or use dev --takeover to move it here.`,
				);
			}

			signal?.throwIfAborted();
			const child = spawn();

			try {
				// Observe spawn errors here until the caller attaches its supervisor.
				await new Promise<void>((resolve, reject) => {
					child.once("spawn", resolve);
					child.once("error", reject);
				});

				const identity = child.pid
					? await readProcessIdentityAsync(child.pid, signal)
					: undefined;
				if (!child.pid || !identity || child.exitCode !== null) {
					throw new Error(`Worker "${name}" exited before process startup`);
				}

				await registry.write(path, [
					...entries,
					{ name, pid: child.pid, identity },
				]);

				// The child can exit while its identity is being written to disk.
				if (child.exitCode !== null || child.signalCode !== null) {
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
		if (
			!entry ||
			!(await matchesProcessIdentityAsync(entry.pid, entry.identity))
		) {
			return false;
		}

		await terminateOwnedProcess({ pid: entry.pid } as ChildProcess, 5000);
		await registry.write(
			path,
			entries.filter((item) => item !== entry),
		);

		return true;
	});
}
