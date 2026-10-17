import { describe, expect, it, spyOn } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { DetachedApp } from "./detached-app";
import { isProcessAlive } from "./lifecycle";
import { terminateOwnedProcess } from "./terminate";

/** A live process in a group of its own, standing in for an unrelated one. */
function spawnBystander(): number {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	child.unref();
	if (!child.pid) throw new Error("sleep did not start");
	return child.pid;
}

describe.skipIf(process.platform === "win32")("terminateOwnedProcess", () => {
	it.each([
		[0, "ESRCH"],
		[100, "ESRCH"],
		[0, "EPERM"],
		[100, "EPERM"],
	] as const)(
		"waits for the leader (grace %d ms, exiting group %s)",
		async (graceMs, exitingGroupError) => {
			const pid = 2_000_000_000;
			let groupPresent = true;
			let leaderPresent = true;
			const kill = process.kill.bind(process);
			const probe = spyOn(process, "kill").mockImplementation(
				(target, signal) => {
					if (Math.abs(target) !== pid) return kill(target, signal);
					const present = target < 0 ? groupPresent : leaderPresent;
					if (!present)
						throw Object.assign(new Error("No such process"), {
							code: target < 0 && leaderPresent ? exitingGroupError : "ESRCH",
						});
					// macOS can remove the group before the parent has reaped its leader.
					if (signal !== 0) groupPresent = false;
					return true;
				},
			);
			let finished = false;
			const stopping = terminateOwnedProcess(
				{ pid, exitCode: null, signalCode: null } as ChildProcess,
				graceMs,
			).then(() => {
				finished = true;
			});
			void stopping.catch(() => {});
			try {
				await Bun.sleep(0);
				expect(finished).toBe(false);
				leaderPresent = false;
				await stopping;
				expect(finished).toBe(true);
			} finally {
				leaderPresent = false;
				try {
					await stopping;
				} finally {
					probe.mockRestore();
				}
			}
		},
	);

	it("fails within the cleanup deadline if signaling stays forbidden", async () => {
		const pid = 2_000_000_000;
		const kill = process.kill.bind(process);
		const probe = spyOn(process, "kill").mockImplementation(
			(target, signal) => {
				if (Math.abs(target) !== pid) return kill(target, signal);
				throw Object.assign(new Error("Operation not permitted"), {
					code: "EPERM",
				});
			},
		);
		try {
			await expect(
				terminateOwnedProcess(
					{ pid, exitCode: null, signalCode: null } as ChildProcess,
					0,
				),
			).rejects.toThrow(`Process group ${pid} did not exit after SIGKILL`);
		} finally {
			probe.mockRestore();
		}
	});

	it("never signals a detached app whose identity stopped matching", async () => {
		const pid = spawnBystander();
		try {
			const gone = new DetachedApp(pid, "v2:bogus");
			gone.exitCode = 0;
			await terminateOwnedProcess(gone, 0);
			expect(isProcessAlive(pid)).toBe(true);

			// Not yet seen to exit: the identity is checked before the first signal.
			await terminateOwnedProcess(new DetachedApp(pid, "v2:bogus"), 0);
			expect(isProcessAlive(pid)).toBe(true);
		} finally {
			process.kill(pid, "SIGKILL");
		}
	});

	it("judges an exited child by its group, not by a pid that may be reused", async () => {
		const pid = 2_000_000_000;
		const signals: [number, string | number | undefined][] = [];
		const kill = process.kill.bind(process);
		const probe = spyOn(process, "kill").mockImplementation(
			(target, signal) => {
				if (Math.abs(target) !== pid) return kill(target, signal);
				signals.push([target, signal]);
				// The group is gone; something else now runs under the pid.
				if (target < 0)
					throw Object.assign(new Error("No such process"), {
						code: "ESRCH",
					});
				return true;
			},
		);
		try {
			await terminateOwnedProcess(
				{ pid, exitCode: 0, signalCode: null } as ChildProcess,
				0,
			);
			expect(signals).toEqual([[-pid, 0]]);
		} finally {
			probe.mockRestore();
		}
	});
});
