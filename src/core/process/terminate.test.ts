import { describe, expect, it, spyOn } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as identities from "../process-identity";
import { readProcessIdentityAsync } from "../process-identity";
import { DetachedApp } from "./detached-app";
import { isProcessAlive } from "./lifecycle";
import { ProcessOwner } from "./process-owner";
import {
	ownedProcessGone,
	ProcessIdentityUnreadable,
	terminateOwnedProcess,
	terminateProcessGroup,
} from "./terminate";

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

describe.skipIf(process.platform === "win32")("an unreadable identity", () => {
	/** A process group whose leader ignores SIGTERM. */
	async function spawnStubborn(): Promise<number> {
		const child = spawn(
			"sh",
			["-c", `trap "" TERM; echo ready; exec sleep 30`],
			{
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		child.unref();
		await new Promise((resolve) => child.stdout?.once("data", resolve));
		return child.pid ?? 0;
	}

	it("refuses to signal a recorded process it cannot identify", async () => {
		const pid = spawnBystander();
		const identity = await readProcessIdentityAsync(pid);
		const read = spyOn(
			identities,
			"readProcessIdentityAsync",
		).mockResolvedValue(undefined);
		try {
			const stopping = terminateProcessGroup(pid, identity ?? "", 0);
			await expect(stopping).rejects.toBeInstanceOf(ProcessIdentityUnreadable);
			await expect(stopping).rejects.toThrow(`pid ${pid}'s identity`);
			expect(isProcessAlive(pid)).toBe(true);
		} finally {
			read.mockRestore();
			process.kill(pid, "SIGKILL");
		}
	});

	it("does not report a TERM-ignoring process stopped when it cannot confirm it before SIGKILL", async () => {
		const pid = await spawnStubborn();
		const identity = await readProcessIdentityAsync(pid);
		const read = spyOn(identities, "readProcessIdentityAsync")
			.mockResolvedValueOnce(identity)
			.mockResolvedValue(undefined);
		try {
			await expect(
				terminateProcessGroup(pid, identity ?? "", 0),
			).rejects.toThrow(`pid ${pid} is still running after SIGTERM`);
			expect(isProcessAlive(pid)).toBe(true);
		} finally {
			read.mockRestore();
			process.kill(-pid, "SIGKILL");
		}
	});

	it("warns instead of silently skipping an adopted app it cannot identify", async () => {
		const pid = spawnBystander();
		const identity = await readProcessIdentityAsync(pid);
		const read = spyOn(
			identities,
			"readProcessIdentityAsync",
		).mockResolvedValue(undefined);
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await terminateOwnedProcess(new DetachedApp(pid, identity ?? ""), 0);
			expect(isProcessAlive(pid)).toBe(true);
			expect(String(warn.mock.calls[0]?.[0])).toContain(`ps -p ${pid}`);
		} finally {
			warn.mockRestore();
			read.mockRestore();
			process.kill(pid, "SIGKILL");
		}
	});
});

describe.skipIf(process.platform === "win32")("ProcessOwner", () => {
	it("forgets an exited app once its group empties, before the group id can be reused", async () => {
		// The leader exits at once; the member it started holds the group, the
		// way a server outlives `bun run dev`.
		const leader = spawn("sh", ["-c", "sleep 30 & echo $!; exit 0"], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const member = new Promise<number>((resolve) =>
			leader.stdout?.once("data", (chunk) => resolve(Number(String(chunk)))),
		);
		// A stand-in whose pid the test can move to another group.
		const app = Object.assign(new EventEmitter(), {
			pid: leader.pid ?? 0,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
		});
		leader.once("exit", (code, signal) => {
			app.exitCode = code;
			app.signalCode = signal;
			app.emit("exit", code, signal);
		});
		const { promise: reported, resolve: exitReported } =
			Promise.withResolvers<void>();
		const owner = new ProcessOwner({
			shutdownGraceMs: 0,
			onAppExit: () => exitReported(),
		});
		owner.register("web", app as unknown as ChildProcess, false);
		let bystander = 0;
		try {
			await reported;
			expect(isProcessAlive(-app.pid)).toBe(true);

			process.kill(await member, "SIGKILL");
			await ownedProcessGone(app as unknown as ChildProcess);
			// An unrelated group now holds the id.
			bystander = spawnBystander();
			app.pid = bystander;

			await owner.stop();
			expect(isProcessAlive(bystander)).toBe(true);
		} finally {
			owner.dispose();
			const sleeper = await member;
			if (isProcessAlive(sleeper)) process.kill(sleeper, "SIGKILL");
			if (bystander && isProcessAlive(bystander))
				process.kill(bystander, "SIGKILL");
		}
	});
});

describe.skipIf(process.platform === "win32")("terminateProcessGroup", () => {
	it("waits for the whole group, not only its leader", async () => {
		// The leader dies on SIGTERM; the member it started ignores it, the
		// way a dev server outlives the shell that spawned it.
		const leader = spawn(
			"sh",
			["-c", `sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait`],
			{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
		);
		const pid = leader.pid ?? 0;
		const member = await new Promise<number>((resolve) =>
			leader.stdout?.once("data", (chunk) => resolve(Number(String(chunk)))),
		);
		try {
			const identity = await readProcessIdentityAsync(pid);
			if (!identity) throw new Error("no identity for the leader");
			expect(await terminateProcessGroup(pid, identity, 200)).toBe(true);
			expect(isProcessAlive(member)).toBe(false);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		}
	});

	it("signals nothing once the pid is another process", async () => {
		const pid = spawnBystander();
		try {
			expect(await terminateProcessGroup(pid, "v2:bogus", 0)).toBe(false);
			expect(isProcessAlive(pid)).toBe(true);
		} finally {
			process.kill(pid, "SIGKILL");
		}
	});
});
