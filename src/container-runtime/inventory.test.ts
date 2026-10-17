import { describe, expect, it } from "bun:test";
import type { BuncargoContainer } from "../types";
import { manualDownCommand } from "./inventory";

const db = { id: "app-db", service: "db" } as BuncargoContainer;
const cache = { id: "app-cache", service: "cache" } as BuncargoContainer;

describe("manualDownCommand", () => {
	it("names the command each runtime removes a stack with, volumes kept", () => {
		expect(
			manualDownCommand({
				projectName: "app",
				runtime: "docker",
				containers: [db, cache],
			}),
		).toBe("docker compose -p app down");
		expect(
			manualDownCommand({
				projectName: "app",
				runtime: "apple",
				containers: [db, cache],
			}),
		).toBe("container delete --force app-db app-cache");
	});
});
