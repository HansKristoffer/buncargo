import { afterEach, describe, expect, it } from "bun:test";
import { portOwnersOf, serviceStatesOf } from "../container-runtime/containers";
import {
	listDockerContainersAsync,
	parseDockerExitCode,
	parseDockerHealth,
	parseDockerPublishedPorts,
} from "./containers";
import { dockerListLine, fakeDocker } from "./fake-docker.testing";

const fakes: ReturnType<typeof fakeDocker>[] = [];
afterEach(() => {
	for (const fake of fakes.splice(0)) fake.remove();
});

function listing(...lines: string[]) {
	const fake = fakeDocker({ ps: { stdout: `${lines.join("\n")}\n` } });
	fakes.push(fake);
	return listDockerContainersAsync(fake.binary);
}

describe("listDockerContainersAsync", () => {
	it("reads state, health, exit code, ports and labels from one line", async () => {
		const [container] = await listing(
			dockerListLine({
				id: "a1",
				name: "demo-postgres-1",
				status: "Up 3 minutes (healthy)",
				ports: "0.0.0.0:5532->5432/tcp, [::]:5532->5432/tcp",
				project: "demo",
				root: "/work/demo",
				service: "postgres",
				serviceHash: "abc",
			}),
		);
		expect(container).toEqual({
			id: "a1",
			name: "demo-postgres-1",
			state: "running",
			runtimeState: "running",
			status: "Up 3 minutes (healthy)",
			healthy: true,
			ports: [5532],
			portsText: "0.0.0.0:5532->5432/tcp, [::]:5532->5432/tcp",
			labels: {
				composeProject: "demo",
				project: "demo",
				root: "/work/demo",
				service: "postgres",
				serviceHash: "abc",
			},
		});
	});

	it("throws when Docker cannot answer, rather than listing nothing", async () => {
		const fake = fakeDocker({
			ps: { exitCode: 1, stderr: "Cannot connect to the Docker daemon" },
		});
		fakes.push(fake);
		await expect(listDockerContainersAsync(fake.binary)).rejects.toThrow(
			/Cannot connect/,
		);
	});

	it("does not take a one-off `compose run` container for the service", async () => {
		const containers = await listing(
			dockerListLine({
				id: "a1",
				project: "demo",
				service: "postgres",
				oneOff: true,
			}),
		);
		expect(serviceStatesOf(containers, "demo")).toEqual([]);
	});
});

describe("serviceStatesOf a Docker listing", () => {
	it("reports a stopped or restarting container as not serving, with its exit code", async () => {
		const containers = await listing(
			dockerListLine({
				id: "a1",
				state: "exited",
				status: "Exited (137) 3 minutes ago",
				project: "demo",
				service: "redis",
			}),
			dockerListLine({
				id: "b2",
				state: "restarting",
				status: "Restarting (1) 2 seconds ago",
				project: "demo",
				service: "search",
			}),
			dockerListLine({ id: "c3", project: "other", service: "redis" }),
			dockerListLine({ id: "d4", name: "unlabelled" }),
		);
		expect(serviceStatesOf(containers, "demo")).toEqual([
			{ service: "redis", state: "stopped", running: false, exitCode: 137 },
			{ service: "search", state: "restarting", running: false, exitCode: 1 },
		]);
	});
});

describe("portOwnersOf a Docker listing", () => {
	it("counts a paused or restarting container as holding its ports, an exited one not", async () => {
		const containers = await listing(
			dockerListLine({
				id: "a1",
				state: "paused",
				ports: "0.0.0.0:5432->5432/tcp",
			}),
			dockerListLine({
				id: "b2",
				state: "restarting",
				ports: "0.0.0.0:6379->6379/tcp",
			}),
			dockerListLine({
				id: "c3",
				state: "exited",
				ports: "0.0.0.0:8025->8025/tcp",
			}),
		);
		expect([...portOwnersOf(containers).keys()]).toEqual([5432, 6379]);
	});

	it("names the checkout buncargo labelled a container with, and no root for a stranger's", async () => {
		const owners = portOwnersOf(
			await listing(
				dockerListLine({
					id: "a1",
					name: "bliss-redis-1",
					ports: "0.0.0.0:13379->6379/tcp",
					project: "bliss",
					root: "/work/bliss",
				}),
				dockerListLine({ id: "b2", ports: "0.0.0.0:8080->80/tcp" }),
			),
		);
		expect(owners.get(13379)).toEqual({
			id: "a1",
			name: "bliss-redis-1",
			composeProject: "bliss",
			root: "/work/bliss",
		});
		expect(owners.get(8080)?.root).toBeUndefined();
	});
});

describe("parseDockerPublishedPorts", () => {
	it("collects every published host port once, ranges expanded", () => {
		expect(
			parseDockerPublishedPorts(
				"0.0.0.0:5532->5432/tcp, [::]:5532->5432/tcp, 0.0.0.0:8000-8002->8000-8002/tcp",
			),
		).toEqual([5532, 8000, 8001, 8002]);
	});

	// A container port with no host mapping is not reachable from the host, so
	// it cannot be the one holding a port we want.
	it("ignores unpublished container ports", () => {
		expect(parseDockerPublishedPorts("5432/tcp")).toEqual([]);
		expect(parseDockerPublishedPorts("")).toEqual([]);
	});
});

describe("parseDockerExitCode", () => {
	it("reads the code of a stopped or restarting container, negative ones too", () => {
		expect(parseDockerExitCode("Exited (137) 3 minutes ago")).toBe(137);
		expect(parseDockerExitCode("exited (-1) 1 second ago")).toBe(-1);
		expect(parseDockerExitCode("Restarting (2) 1 second ago")).toBe(2);
		expect(parseDockerExitCode("Up 3 minutes")).toBeUndefined();
	});
});

describe("parseDockerHealth", () => {
	it("reads Docker's own healthcheck verdict", () => {
		expect(parseDockerHealth("Up 3 minutes (healthy)")).toBe(true);
		expect(parseDockerHealth("Up 3 minutes (unhealthy)")).toBe(false);
	});

	// A container with no healthcheck has not answered, which is not the same
	// as answering "no": reading it as healthy would skip a probe wrongly.
	it("says nothing about a missing or starting healthcheck", () => {
		expect(parseDockerHealth("Up 3 minutes")).toBeUndefined();
		expect(
			parseDockerHealth("Up 2 seconds (health: starting)"),
		).toBeUndefined();
	});
});
