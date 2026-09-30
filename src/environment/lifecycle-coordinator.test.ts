import { expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import { withSignal } from "../core/deadline";
import { LifecycleCoordinator } from "./lifecycle-coordinator";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("stop cancels startup and waits for its cleanup before teardown", async () => {
	const coordinator = new LifecycleCoordinator();
	const entered = gate();
	const cleanup = gate();
	const events: string[] = [];
	const starting = coordinator
		.start(async (signal) => {
			entered.resolve();
			try {
				await withSignal(new Promise(() => {}), signal);
			} finally {
				await cleanup.promise;
				events.push("startup cleanup");
			}
		})
		.catch((error) => error);
	await entered.promise;
	const stopped = coordinator.stop(async () => {
		events.push("stop");
	});
	await expect(coordinator.start(async () => {})).rejects.toThrow(
		"already starting",
	);
	await Promise.resolve();
	expect(events).toEqual([]);
	cleanup.resolve();
	await stopped;
	expect(await starting).toMatchObject({
		message: "Startup cancelled by stop",
	});
	expect(events).toEqual(["startup cleanup", "stop"]);
});

it("serializes stop requests, preserving a later stronger teardown", async () => {
	const coordinator = new LifecycleCoordinator();
	const entered = gate();
	const release = gate();
	const events: string[] = [];
	const first = coordinator.stop(async () => {
		entered.resolve();
		await release.promise;
		events.push("containers");
	});
	await entered.promise;
	const second = coordinator.stop(async () => {
		events.push("volumes");
	});
	await expect(coordinator.start(async () => {})).rejects.toThrow("lifecycle");
	release.resolve();
	await Promise.all([first, second]);
	expect(events).toEqual(["containers", "volumes"]);
});

it("coalesces concurrent restarts and lets a subsequent stop supersede startup", async () => {
	const coordinator = new LifecycleCoordinator();
	const entered = gate();
	const events: string[] = [];
	const stop = async () => {
		events.push("restart stop");
	};
	const start = async (signal: AbortSignal) => {
		events.push("restart start");
		entered.resolve();
		await withSignal(new Promise(() => {}), signal);
	};
	const first = coordinator.restart(stop, start);
	const second = coordinator.restart(stop, start);
	expect(second).toBe(first);
	const outcome = first.catch((error) => error);
	await entered.promise;
	await coordinator.stop(async () => {
		events.push("final stop");
	});
	expect(await outcome).toMatchObject({ message: "Restart cancelled by stop" });
	expect(events).toEqual(["restart stop", "restart start", "final stop"]);
	await coordinator.start(async () => {});
	await coordinator.stop(async () => {});
});

it("recovers from teardown failure and detaches caller cancellation after stop", async () => {
	const coordinator = new LifecycleCoordinator();
	const caller = new AbortController();
	let sessionSignal!: AbortSignal;
	await coordinator.start(async (signal) => {
		sessionSignal = signal;
	}, caller.signal);
	expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);
	await expect(
		coordinator.stop(async () => {
			throw new Error("failed stop");
		}),
	).rejects.toThrow("failed stop");
	caller.abort(new Error("caller cancelled"));
	expect(sessionSignal.reason.message).toBe("caller cancelled");
	await coordinator.stop(async () => {});
	expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
	await coordinator.start(async () => {});
	await coordinator.stop(async () => {});
});
