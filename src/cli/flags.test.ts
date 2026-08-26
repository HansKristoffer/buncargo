import { describe, expect, it } from "bun:test";
import { getFlagValue, hasFlag, splitCliArgs } from "./flags";

describe("hasFlag", () => {
	it("returns true when flag is present", () => {
		const args = ["--down", "--verbose"];

		expect(hasFlag(args, "--down")).toBe(true);
		expect(hasFlag(args, "--verbose")).toBe(true);
	});

	it("returns false when flag is absent", () => {
		const args = ["--down"];

		expect(hasFlag(args, "--up")).toBe(false);
		expect(hasFlag(args, "--reset")).toBe(false);
	});

	it("returns false for empty args array", () => {
		const args: string[] = [];

		expect(hasFlag(args, "--down")).toBe(false);
	});

	it("does not match partial flags", () => {
		const args = ["--down-all"];

		expect(hasFlag(args, "--down")).toBe(false);
	});

	it("treats --flag=value as presence of --flag", () => {
		const args = ["--timeout=10", "--verbose"];

		expect(hasFlag(args, "--timeout=10")).toBe(true);
		expect(hasFlag(args, "--timeout")).toBe(true);
	});

	it("treats --expose=name as requesting expose", () => {
		const args = ["--expose=api"];

		expect(hasFlag(args, "--expose")).toBe(true);
	});
});

describe("getFlagValue", () => {
	describe("--flag=value format", () => {
		it("parses value from --flag=value format", () => {
			const args = ["--timeout=10"];

			expect(getFlagValue(args, "--timeout")).toBe("10");
		});

		it("handles string values", () => {
			const args = ["--name=myapp"];

			expect(getFlagValue(args, "--name")).toBe("myapp");
		});

		it("handles values with special characters", () => {
			const args = ["--path=/home/user/my-project"];

			expect(getFlagValue(args, "--path")).toBe("/home/user/my-project");
		});

		it("handles empty value", () => {
			const args = ["--name="];

			expect(getFlagValue(args, "--name")).toBe("");
		});

		it("parses comma-separated expose names", () => {
			const args = ["--expose=api,web"];

			expect(getFlagValue(args, "--expose")).toBe("api,web");
		});
	});

	describe("--flag value format", () => {
		it("parses value from --flag value format", () => {
			const args = ["--timeout", "10"];

			expect(getFlagValue(args, "--timeout")).toBe("10");
		});

		it("handles string values", () => {
			const args = ["--name", "myapp"];

			expect(getFlagValue(args, "--name")).toBe("myapp");
		});

		it("handles values with paths", () => {
			const args = ["--cwd", "/home/user/project"];

			expect(getFlagValue(args, "--cwd")).toBe("/home/user/project");
		});

		it("parses expose names from separate value", () => {
			const args = ["--expose", "api,web"];

			expect(getFlagValue(args, "--expose")).toBe("api,web");
		});
	});

	describe("edge cases", () => {
		it("returns undefined when flag not found", () => {
			const args = ["--timeout", "10"];

			expect(getFlagValue(args, "--name")).toBeUndefined();
		});

		it("returns undefined when flag is at end of array with no value", () => {
			const args = ["--verbose", "--timeout"];

			expect(getFlagValue(args, "--timeout")).toBeUndefined();
		});

		it("ignores values that start with dash (another flag)", () => {
			const args = ["--timeout", "--verbose"];

			expect(getFlagValue(args, "--timeout")).toBeUndefined();
		});

		it("returns undefined for empty args array", () => {
			const args: string[] = [];

			expect(getFlagValue(args, "--timeout")).toBeUndefined();
		});

		it("prefers --flag=value format over --flag value", () => {
			const args = ["--timeout=5", "--timeout", "10"];

			expect(getFlagValue(args, "--timeout")).toBe("5");
		});

		it("handles multiple flags correctly", () => {
			const args = ["--name=myapp", "--port", "3000", "--verbose"];

			expect(getFlagValue(args, "--name")).toBe("myapp");
			expect(getFlagValue(args, "--port")).toBe("3000");
			expect(getFlagValue(args, "--verbose")).toBeUndefined();
		});
	});
});

describe("splitCliArgs", () => {
	it("splits passthrough args after --", () => {
		expect(splitCliArgs(["--apps=expoApp", "--", "--clear"])).toEqual({
			flags: ["--apps=expoApp"],
			passthrough: ["--clear"],
		});
	});
});
