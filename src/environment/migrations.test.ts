import { describe, expect, it } from "bun:test";
import { runMigrationsSequentially } from "./migrations";

describe("runMigrationsSequentially", () => {
	it("runs migrations in order", async () => {
		const calls: string[] = [];

		await runMigrationsSequentially(
			[
				{ name: "one", command: "first" },
				{ name: "two", command: "second" },
			],
			async (command) => {
				calls.push(command);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		);

		expect(calls).toEqual(["first", "second"]);
	});

	it("stops on the first failure", async () => {
		const calls: string[] = [];

		await expect(
			runMigrationsSequentially(
				[
					{ name: "one", command: "first" },
					{ name: "two", command: "second" },
				],
				async (command) => {
					calls.push(command);
					if (command === "first") {
						return { exitCode: 1, stdout: "bad", stderr: "failed" };
					}
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			),
		).rejects.toThrow('Migration "one" failed');

		expect(calls).toEqual(["first"]);
	});
});
