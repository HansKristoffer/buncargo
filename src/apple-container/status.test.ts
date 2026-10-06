import { describe, expect, it } from "bun:test";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import {
	appleProjectServiceStates,
	findAppleContainerOnPort,
	formatPublishedPorts,
	listAppleBuncargoContainers,
	parseContainerRecords,
	probeAppleServicePort,
} from "./status";

const LS_JSON = JSON.stringify([
	{
		status: "running",
		configuration: {
			id: "gey-main-postgres",
			hostname: "gey-main-postgres",
			labels: {
				"buncargo.project": "gey-main",
				"buncargo.root": "/repo",
				"buncargo.worktree": "",
				"buncargo.service": "postgres",
			},
			publishedPorts: [
				{
					hostAddress: "0.0.0.0",
					hostPort: 5433,
					containerPort: 5432,
					protocol: "tcp",
				},
			],
		},
	},
	{
		status: { state: "stopped" },
		configuration: {
			id: "gey-main-redis",
			labels: {
				"buncargo.project": "gey-main",
				"buncargo.service": "redis",
			},
			publishedPorts: [],
		},
	},
	{
		status: "running",
		configuration: { id: "someone-elses-thing", labels: {} },
	},
]);

function stubCli(stdout: string, ok = true): AppleContainerCli {
	const result: AppleCliResult = {
		ok,
		exitCode: ok ? 0 : 1,
		stdout,
		stderr: "",
	};
	return {
		binary: "container",
		found: true,
		run: () => result,
		runAsync: async () => result,
	};
}

describe("parseContainerRecords", () => {
	it("reads id, state, labels and ports", () => {
		const records = parseContainerRecords(LS_JSON);
		expect(records).toHaveLength(3);
		expect(records[0]?.id).toBe("gey-main-postgres");
		expect(records[0]?.state).toBe("running");
		expect(records[0]?.labels["buncargo.service"]).toBe("postgres");
		expect(records[0]?.ports).toEqual([
			{
				hostAddress: "0.0.0.0",
				hostPort: 5433,
				containerPort: 5432,
				protocol: "tcp",
			},
		]);
	});

	it("reads the object form of status", () => {
		expect(parseContainerRecords(LS_JSON)[1]?.state).toBe("stopped");
	});

	it("accepts string port entries", () => {
		const records = parseContainerRecords(
			JSON.stringify([
				{ id: "x", status: "running", ports: ["0.0.0.0:8080:80/tcp"] },
			]),
		);
		expect(records[0]?.ports).toEqual([
			{
				hostAddress: "0.0.0.0",
				hostPort: 8080,
				containerPort: 80,
				protocol: "tcp",
			},
		]);
	});

	it("returns nothing for empty or unparseable output", () => {
		expect(parseContainerRecords("")).toEqual([]);
		expect(parseContainerRecords("not json")).toEqual([]);
	});

	it("skips entries with no id rather than inventing one", () => {
		expect(
			parseContainerRecords(JSON.stringify([{ status: "running" }])),
		).toEqual([]);
	});
});

describe("formatPublishedPorts", () => {
	it("renders the docker-style mapping the CLI prints", () => {
		expect(
			formatPublishedPorts([
				{ hostAddress: "0.0.0.0", hostPort: 5433, containerPort: 5432 },
			]),
		).toBe("0.0.0.0:5433->5432/tcp");
	});
});

describe("listAppleBuncargoContainers", () => {
	it("keeps only buncargo-labeled containers", () => {
		const containers = listAppleBuncargoContainers(stubCli(LS_JSON));
		expect(containers.map((item) => item.service)).toEqual([
			"postgres",
			"redis",
		]);
		expect(containers[0]?.runtime).toBe("apple");
		expect(containers[0]?.ports).toBe("0.0.0.0:5433->5432/tcp");
	});

	it("throws when the runtime cannot answer, rather than reporting no containers", () => {
		// The sweep retires records only for runtimes that answered, so "down"
		// must never look like "empty".
		expect(() => listAppleBuncargoContainers(stubCli("", false))).toThrow();
	});
});

describe("appleProjectServiceStates", () => {
	it("reports each labeled service's state for the project only", async () => {
		const states = await appleProjectServiceStates(
			stubCli(LS_JSON),
			"gey-main",
		);
		expect(states.map((state) => [state.service, state.running])).toEqual([
			["postgres", true],
			["redis", false],
		]);
		expect(await appleProjectServiceStates(stubCli(LS_JSON), "other")).toEqual(
			[],
		);
	});
});

describe("findAppleContainerOnPort", () => {
	it("finds a running container publishing the host port", () => {
		expect(findAppleContainerOnPort(stubCli(LS_JSON), 5433)).toEqual({
			id: "gey-main-postgres",
			name: "gey-main-postgres",
			composeProject: "gey-main",
		});
	});

	it("ignores the container port and unknown ports", () => {
		expect(findAppleContainerOnPort(stubCli(LS_JSON), 5432)).toBeUndefined();
		expect(findAppleContainerOnPort(stubCli(LS_JSON), 9999)).toBeUndefined();
	});
});

/** `ls` output in the 1.3 shape: state, networks and `proto` under their keys. */
function liveRecord(options: {
	state?: string;
	address?: string;
	ports: Record<string, unknown>[];
}): string {
	return JSON.stringify([
		{
			status: {
				state: options.state ?? "running",
				networks: options.address
					? [{ ipv4Address: `${options.address}/24`, network: "default" }]
					: [],
			},
			configuration: {
				id: "gey-main-api",
				labels: { "buncargo.project": "gey-main" },
				publishedPorts: options.ports,
			},
		},
	]);
}

describe("the 1.3 ls shape", () => {
	it("reads the container address, proto and port ranges", () => {
		const [record] = parseContainerRecords(
			liveRecord({
				address: "192.168.64.5",
				ports: [
					{ hostPort: 7000, containerPort: 7000, proto: "udp", count: 3 },
				],
			}),
		);
		expect(record?.address).toBe("192.168.64.5");
		expect(record?.ports).toEqual([
			{ hostPort: 7000, containerPort: 7000, protocol: "udp", count: 3 },
		]);
	});

	it("counts every port of a published range as owned", () => {
		const cli = stubCli(
			liveRecord({
				address: "192.168.64.5",
				ports: [{ hostPort: 7000, containerPort: 7000, count: 3 }],
			}),
		);
		expect(findAppleContainerOnPort(cli, 7002)?.id).toBe("gey-main-api");
		expect(findAppleContainerOnPort(cli, 7003)).toBeUndefined();
	});
});

describe("probeAppleServicePort", () => {
	const request = {
		projectName: "gey-main",
		serviceName: "api",
		hostPort: 18080,
	};

	it("connects to the container port at the container's address", async () => {
		// A local listener stands in for the service inside the container.
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		try {
			const cli = stubCli(
				liveRecord({
					address: "127.0.0.1",
					ports: [{ hostPort: 18080, containerPort: server.port }],
				}),
			);
			expect(await probeAppleServicePort(cli, request)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("is false when nothing listens behind the published port", async () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = server.port;
		server.stop(true);
		const cli = stubCli(
			liveRecord({
				address: "127.0.0.1",
				ports: [{ hostPort: 18080, containerPort: port }],
			}),
		);
		expect(await probeAppleServicePort(cli, request)).toBe(false);
	});

	it("is false for a stopped container or one with no address", async () => {
		const ports = [{ hostPort: 18080, containerPort: 1 }];
		expect(
			await probeAppleServicePort(
				stubCli(liveRecord({ state: "stopped", address: "127.0.0.1", ports })),
				request,
			),
		).toBe(false);
		expect(
			await probeAppleServicePort(stubCli(liveRecord({ ports })), request),
		).toBe(false);
	});
});
