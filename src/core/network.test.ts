import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../types";
import { waitForDevServers } from "./network";

describe("waitForDevServers", () => {
	it("skips apps with healthEndpoint: false", async () => {
		const apps: Record<string, AppConfig> = {
			metro: {
				port: 1,
				devCommand: "bunx expo start",
				healthEndpoint: false,
			},
		};
		await expect(
			waitForDevServers(apps, { metro: 1 }, { verbose: false }),
		).resolves.toBeUndefined();
	});
});
