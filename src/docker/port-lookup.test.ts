import { describe, expect, it } from "bun:test";
import {
	parseDockerPublishedPort,
	parseDockerPublishedPorts,
} from "./port-lookup";

describe("parseDockerPublishedPort", () => {
	it("matches published TCP ports from docker ps", () => {
		expect(parseDockerPublishedPort("0.0.0.0:5532->5432/tcp", 5532)).toBe(true);
		expect(parseDockerPublishedPort("0.0.0.0:5532->5432/tcp", 5432)).toBe(
			false,
		);
	});
});

describe("parseDockerPublishedPorts", () => {
	it("collects every published host port in one pass", () => {
		expect(
			parseDockerPublishedPorts(
				"0.0.0.0:5532->5432/tcp, [::]:5532->5432/tcp, 0.0.0.0:8025->8025/tcp",
			),
		).toEqual([5532, 8025]);
	});

	// A container port with no host mapping is not reachable from the host, so
	// it cannot be the one holding a port we want.
	it("ignores unpublished container ports", () => {
		expect(parseDockerPublishedPorts("5432/tcp")).toEqual([]);
		expect(parseDockerPublishedPorts("")).toEqual([]);
	});

	it("does not confuse the container port with the host port", () => {
		expect(parseDockerPublishedPorts("0.0.0.0:5532->5432/tcp")).toEqual([5532]);
	});
});
