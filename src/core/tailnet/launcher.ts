import { spawn } from "node:child_process";
import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { matchesProcessIdentity } from "../process-identity";
import { stateFilePath } from "../state-paths";
import { installTailnetBundle } from "./bundle";
import {
	COORDINATOR_STARTING,
	isCoordinatorReady,
	readCoordinatorState,
} from "./coordinator-state";

/** Copy a self-contained bundle out of the package cache; one launcher at a time can start it. */
export async function ensureTailnetCoordinator(
	signal?: AbortSignal,
): Promise<void> {
	const bundle = installTailnetBundle();
	const owner = await withFileLock(
		stateFilePath("tailnet-launch"),
		async () => {
			const existing = await readCoordinatorState();
			if (existing) {
				if (existing.bundle !== bundle)
					throw new Error(
						"A different Buncargo build is sharing services. Stop its dev sessions before starting this build.",
					);
				return existing;
			}
			const child = spawn(process.execPath, [bundle], {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
			child.unref();
			// Hold the launch lock until the child has published its birth identity. Concurrent worktrees adopt it.
			for (let i = 0; i < 100; i++) {
				const state = await readCoordinatorState(false);
				if (state && state.pid === child.pid) return state;
				if (child.exitCode !== null)
					throw new Error("Tailscale coordinator exited during startup");
				await abortableSleep(50, signal);
			}
			throw new Error("Tailscale coordinator did not start");
		},
		{ timeoutMs: 5000 },
	);
	const deadline = Date.now() + 180000;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		const state = await readCoordinatorState(false);
		if (state?.pid === owner.pid && state.identity === owner.identity) {
			if (isCoordinatorReady(state)) return;
			if (state.message && state.message !== COORDINATOR_STARTING)
				throw new Error(state.message);
			if (!matchesProcessIdentity(state.pid, state.identity))
				throw new Error("Tailscale coordinator stopped during startup");
		}
		await abortableSleep(250, signal);
	}
	throw new Error(
		"Tailscale startup timed out. Check the auth key and network access.",
	);
}
