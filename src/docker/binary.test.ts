import { describe, expect, it } from "bun:test";
import { dockerArgv } from "./binary";

describe("dockerArgv", () => {
	it("runs the context's engine for a plain binary", () => {
		expect(dockerArgv(undefined, ["ps"])).toEqual(["docker", "ps"]);
		expect(dockerArgv("/opt/docker", ["ps"])).toEqual(["/opt/docker", "ps"]);
	});

	it("names the engine on every command when one is pinned", () => {
		expect(
			dockerArgv({ host: "unix:///o/docker.sock" }, ["compose", "up"]),
		).toEqual(["docker", "--host", "unix:///o/docker.sock", "compose", "up"]);
		expect(dockerArgv({ binary: "/opt/docker" }, ["ps"])).toEqual([
			"/opt/docker",
			"ps",
		]);
	});
});
