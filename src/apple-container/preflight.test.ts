import { describe, expect, it } from "bun:test";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import {
	appleStartAction,
	appleStartFailureRemediation,
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

describe("appleStartAction", () => {
	it("waits in CI for a service a runner is bringing up, as Docker does", () => {
		expect(appleStartAction(false, true)).toBe("wait");
		expect(appleStartAction(false, false)).toBe("refuse");
		expect(appleStartAction(true, false)).toBe("start");
	});
});

describe("appleStartFailureRemediation", () => {
	const failed = (stderr: string, stdout = ""): AppleCliResult => ({
		ok: false,
		exitCode: 1,
		stdout,
		stderr,
	});

	it("names the one-time kernel install apart from any other failed start", () => {
		const noKernel = appleStartFailureRemediation(
			failed("", "Install the recommended default kernel? [Y/n]"),
		);
		expect(noKernel).toContain("no kernel installed yet");
		expect(noKernel).toContain("once in a terminal");

		const other = appleStartFailureRemediation(failed("XPC connection error"));
		expect(other).not.toContain("kernel");
		expect(other).toContain("Last error: XPC connection error");
	});
});

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
