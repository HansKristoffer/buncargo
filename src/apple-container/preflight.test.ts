import { describe, expect, it } from "bun:test";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import {
	ensureAppleContainerRunning,
	isAppleContainerSupported,
} from "./preflight";

function failingCli(stderr: string): AppleContainerCli {
	const result: AppleCliResult = { ok: false, exitCode: 1, stdout: "", stderr };
	return {
		binary: "container",
		found: true,
		run: () => result,
		runAsync: async () => result,
	};
}

describe.skipIf(!isAppleContainerSupported())(
	"ensureAppleContainerRunning",
	() => {
		it("fails at once when the system cannot start, not after the timeout", async () => {
			const start = performance.now();
			await expect(
				ensureAppleContainerRunning(failingCli("kernel not installed"), {
					autoStart: true,
					timeoutMs: 10_000,
					verbose: false,
				}),
			).rejects.toThrow(/system start.*Last error: kernel not installed/);
			expect(performance.now() - start).toBeLessThan(1000);
		});
	},
);
