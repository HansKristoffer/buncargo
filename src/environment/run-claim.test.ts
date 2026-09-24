import { describe, expect, it } from "bun:test";
import { resolveClaimHold } from "./run-claim";

describe("resolveClaimHold", () => {
	it("keeps a library run's containers unless something asks for a hold", () => {
		// A script that brings a stack up and exits looks like a crash to the
		// sweep; with a hold it would lose its containers seconds later.
		expect(resolveClaimHold({}, undefined)).toBeUndefined();
	});

	it("ignores `options.autoShutdown` for a library run, which is the CLI's", () => {
		// The configured hold is `buncargo dev`'s. Applied to a script that
		// exits normally, it is the crash path: containers gone in seconds.
		expect(resolveClaimHold({}, 60_000)).toBeUndefined();
		expect(
			resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, false),
		).toBeUndefined();
	});

	it("uses the caller's default only when neither the flag nor the config says", () => {
		// The CLI's three minutes.
		expect(resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, undefined)).toBe(
			180_000,
		);
		expect(resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, 60_000)).toBe(
			60_000,
		);
	});

	it("puts an explicit request above everything, `false` included", () => {
		expect(resolveClaimHold({ idleTimeoutMs: 5_000 }, 60_000)).toBe(5_000);
		expect(
			resolveClaimHold(
				{ idleTimeoutMs: false, defaultIdleTimeoutMs: 180_000 },
				60_000,
			),
		).toBeUndefined();
	});
});
