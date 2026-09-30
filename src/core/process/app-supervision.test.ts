import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { AppSupervision } from "./app-supervision";
import { isProcessAlive } from "./lifecycle";

function child() {
	return spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
}

it("keeps supervision alive across replacement of its last child", async () => {
	const session = new AppSupervision({ width: 1 });
	let replacementPid: number | undefined;
	try {
		await session.register("worker", child(), true, false, false);
		const first = session.pids.worker;
		const watching = session.owner.wait().catch(() => {});
		session.setSpawner("worker", async () => child(), true, false);
		await session.restart("worker");
		replacementPid = session.pids.worker;
		if (replacementPid === undefined)
			throw new Error("Replacement did not have a pid");
		expect(replacementPid).not.toBe(first);
		expect(session.owner.controller.signal.aborted).toBe(false);
		expect(isProcessAlive(replacementPid)).toBe(true);
		await session.stop();
		await watching;
		expect(isProcessAlive(replacementPid)).toBe(false);
	} finally {
		await session.stop();
	}
});

it("never respawns a child when stop arrives while it is being retired", async () => {
	const session = new AppSupervision({ width: 1 });
	let spawns = 0;
	try {
		await session.register("worker", child(), true, false, false);
		session.setSpawner(
			"worker",
			async () => {
				spawns++;
				return child();
			},
			true,
			false,
		);
		const replacing = session.restart("worker").catch(() => {});
		await session.stop();
		await replacing;
		expect(spawns).toBe(0);
		const pid = session.pids.worker;
		if (pid === undefined) throw new Error("Worker did not have a pid");
		expect(isProcessAlive(pid)).toBe(false);
	} finally {
		await session.stop();
	}
});
