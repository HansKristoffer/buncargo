import { describe, expect, it } from "bun:test";
import {
	parseDockerPortOwners,
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

describe("parseDockerPortOwners", () => {
	it("reads the checkout root buncargo labels its containers with", () => {
		const owners = parseDockerPortOwners(
			[
				"a1\tbliss-t3-e144b332-redis-1\t0.0.0.0:13379->6379/tcp\tbliss-t3-e144b332\t/work/t3-e144b332",
				"b2\tsomeone-else\t0.0.0.0:8080->80/tcp\t\t",
			].join("\n"),
		);
		expect(owners.get(13379)).toEqual({
			id: "a1",
			name: "bliss-t3-e144b332-redis-1",
			composeProject: "bliss-t3-e144b332",
			root: "/work/t3-e144b332",
		});
		expect(owners.get(8080)?.root).toBeUndefined();
	});

	it("counts a paused or restarting container as holding its ports, an exited one not", () => {
		const owners = parseDockerPortOwners(
			[
				"a1\tpaused\t0.0.0.0:5432->5432/tcp\tapp\t/work\tpaused",
				"b2\trestarting\t0.0.0.0:6379->6379/tcp\tapp\t/work\trestarting",
				"c3\texited\t0.0.0.0:8025->8025/tcp\tapp\t/work\texited",
			].join("\n"),
		);
		expect([...owners.keys()]).toEqual([5432, 6379]);
	});
});
