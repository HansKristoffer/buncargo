import { describe, expect, it, spyOn } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { terminateOwnedProcess } from "./terminate";

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
				{ pid } as ChildProcess,
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
				terminateOwnedProcess({ pid } as ChildProcess, 0),
			).rejects.toThrow(`Process group ${pid} did not exit after SIGKILL`);
		} finally {
			probe.mockRestore();
		}
	});
});
