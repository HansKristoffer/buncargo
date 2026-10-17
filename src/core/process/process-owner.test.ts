import { describe, expect, it } from "bun:test";
import { appExitState } from "./process-owner";

describe("appExitState", () => {
	const server = { worker: false, optional: false };
	const worker = { worker: true, optional: false };
	// Non-essential, or parked after it never came up.
	const optionalWorker = { worker: true, optional: true };

	it.each([
		[0, null, server, "stopped"],
		[1, null, server, "failed"],
		[130, null, server, "stopped"],
		[143, null, server, "stopped"],
		[null, "SIGTERM", server, "stopped"],
		[null, "SIGINT", server, "stopped"],
		[null, "SIGKILL", server, "failed"],
		[0, null, worker, "failed"],
		[null, "SIGTERM", worker, "stopped"],
		[0, null, optionalWorker, "stopped"],
		[1, null, optionalWorker, "failed"],
	] as const)("exit %p, signal %p, %o reads %s", (code, signal, app, state) => {
		expect(appExitState(code, signal, app)).toBe(state);
	});
});
