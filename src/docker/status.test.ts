import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { assertDockerRunning, dockerProjectServiceStates } from "./status";

describe("dockerProjectServiceStates", () => {
	it("throws when Docker cannot answer, rather than listing an empty project", async () => {
		// The test preload's `docker` answers as one with no daemon does.
		await expect(dockerProjectServiceStates("demo")).rejects.toThrow(
			/Cannot connect to the Docker daemon/,
		);
	});
});

describe("assertDockerRunning", () => {
	it("says once that Docker is not running, and what to do", () => {
		const missing = join(import.meta.dir, "no-such-docker-binary");
		expect(() => assertDockerRunning(missing)).toThrow(
			/^Docker is not running.*try again\.$/,
		);
	});

	it.skipIf(process.platform !== "linux")(
		"names the runtime behind docker rather than 'unknown'",
		() => {
			const missing = join(import.meta.dir, "no-such-docker-binary");
			expect(() => assertDockerRunning(missing)).toThrow(
				/^Docker is not running \(docker-engine\)\. Start the Docker service/,
			);
		},
	);
});
