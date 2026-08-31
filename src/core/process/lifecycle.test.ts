import { describe, expect, it } from "bun:test";
import { isProcessAlive } from "./lifecycle";

describe("isProcessAlive", () => {
	it("follows a process it owns", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("reports a pid that cannot exist as gone", () => {
		// Above the macOS/Linux pid maximum, so kill() answers ESRCH.
		expect(isProcessAlive(4_194_304)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"counts a process it is not allowed to signal as alive",
		() => {
			// pid 1 is launchd/init: alive, root-owned, and `kill(1, 0)` from an
			// unelevated process fails with EPERM. Reading that as "dead" made a
			// user-level CLI break the root hosts daemon's registry lock the
			// moment it held one, and prune away every route the daemon owned.
			expect(isProcessAlive(1)).toBe(true);
		},
	);
});
