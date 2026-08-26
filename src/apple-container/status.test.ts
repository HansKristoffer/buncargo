import { describe, expect, it } from "bun:test";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import {
	areAppleServicesRunning,
	findAppleContainerOnPort,
	formatPublishedPorts,
	listAppleBuncargoContainers,
	parseContainerRecords,
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
	return { binary: "container", found: true, run: () => result };
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

	it("returns nothing when the command fails", () => {
		expect(listAppleBuncargoContainers(stubCli("", false))).toEqual([]);
	});
});

describe("areAppleServicesRunning", () => {
	it("is true only when every requested service is running", () => {
		const cli = stubCli(LS_JSON);
		expect(areAppleServicesRunning(cli, "gey-main", ["postgres"])).toBe(true);
		expect(
			areAppleServicesRunning(cli, "gey-main", ["postgres", "redis"]),
		).toBe(false);
	});

	it("is false for another project and for an empty request", () => {
		const cli = stubCli(LS_JSON);
		expect(areAppleServicesRunning(cli, "other", ["postgres"])).toBe(false);
		expect(areAppleServicesRunning(cli, "gey-main", [])).toBe(false);
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
