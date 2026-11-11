import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServices } from "../config/resolve";
import { readRemovals } from "../core/removal-log";
import { buildRunEntry, publishRun } from "../core/run-registry";
import type { PortContainerOwner } from "../types";
import { fakeRuntime, runtimeContainer } from "./fake-runtime.testing";
import { assertServicePortsClaimable } from "./service-ports";
import {
	decideStaleStack,
	findStaleStacks,
	replaceStaleStacks,
} from "./stale-stacks";
import type { ContainerDownRequest, ContainerRuntimeAdapter } from "./types";

// The checkout from the retrospective: renamed from bliss to budget-app, its
// old stack still publishing the ports the new name is given.
const root = "/work/t3-e144b332";
const checkout = { root, projectPrefix: "budget-app" };
const staleRedis: PortContainerOwner = {
	id: "a1",
	name: "bliss-t3-e144b332-redis-1",
	composeProject: "bliss-t3-e144b332",
	root,
};
const otherCheckout: PortContainerOwner = {
	id: "b2",
	name: "bliss-t3-other-redis-1",
	composeProject: "bliss-t3-other",
	root: "/work/t3-other",
};

/**
 * A runtime listing a container for each of `owners`, publishing its port,
 * plus `extra` containers that publish none.
 */
function stackRuntime(
	owners: Map<number, PortContainerOwner>,
	options: {
		name?: ContainerRuntimeAdapter["name"];
		extra?: { project: string; root: string }[];
	} = {},
): { runtime: ContainerRuntimeAdapter; downs: ContainerDownRequest[] } {
	const downs: ContainerDownRequest[] = [];
	const listed = [
		...[...owners].map(([port, owner]) =>
			runtimeContainer({
				id: owner.id,
				name: owner.name,
				ports: [port],
				labels: {
					composeProject: owner.composeProject,
					project: owner.composeProject,
					root: owner.root,
				},
			}),
		),
		...(options.extra ?? []).map(({ project, root }) =>
			runtimeContainer({
				labels: { composeProject: project, project, root },
			}),
		),
	];
	const runtime = fakeRuntime({
		name: options.name ?? "docker",
		containers: async () => listed,
		down: async (request: ContainerDownRequest) => {
			downs.push(request);
		},
	});
	return { runtime, downs };
}

let home: string;
let savedHome: string | undefined;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-stale-home-")));
	savedHome = process.env.HOME;
	process.env.HOME = home;
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
});

describe("findStaleStacks", () => {
	it("groups a stale stack's wanted ports and leaves current and foreign stacks out", () => {
		const owners = new Map<number, PortContainerOwner>([
			[13379, staleRedis],
			[13380, { ...staleRedis, name: "bliss-t3-e144b332-postgres-1" }],
			[13381, otherCheckout],
			// The current config's own stacks, dev and a suffixed one.
			[
				13382,
				{ id: "c", name: "x", composeProject: "budget-app-t3-e144b332", root },
			],
			[
				13383,
				{
					id: "d",
					name: "y",
					composeProject: "budget-app-t3-e144b332-ci",
					root,
				},
			],
		]);
		const wanted = new Set([13379, 13380, 13381, 13382, 13383]);
		expect(findStaleStacks(owners, checkout, "docker", wanted)).toEqual([
			{
				projectName: "bliss-t3-e144b332",
				runtime: "docker",
				ports: [13379, 13380],
			},
		]);
	});

	it("leaves a stale stack that holds none of the ports this run wants", () => {
		const owners = new Map([[13379, staleRedis]]);
		expect(
			findStaleStacks(owners, checkout, "docker", new Set([3000])),
		).toEqual([]);
	});
});

describe("decideStaleStack", () => {
	const projectName = "bliss-t3-e144b332";

	it("removes a project whose every container is this checkout's", () => {
		expect(
			decideStaleStack({
				projectName,
				root,
				containers: [{ root }, { root }],
				liveRuns: [],
			}),
		).toEqual({ remove: true });
	});

	it("keeps a project that also has another checkout's containers", () => {
		const decision = decideStaleStack({
			projectName,
			root,
			containers: [{ root }, { root: "/work/main" }],
			liveRuns: [],
		});
		expect(decision).toEqual({
			remove: false,
			reason:
				"it also has containers of /work/main, so it is not this checkout's alone",
		});
	});

	it("keeps a project a live run uses, whatever its checkout", () => {
		const decision = decideStaleStack({
			projectName,
			root,
			containers: [{ root }],
			liveRuns: [{ projectName, root: "/work/main", pid: 4242 }],
		});
		expect(decision.remove).toBe(false);
	});
});

describe("replaceStaleStacks", () => {
	const wanted = [13379];

	it("downs a stale stack of this checkout, keeping its volumes, and records it", async () => {
		const { runtime, downs } = stackRuntime(new Map([[13379, staleRedis]]));

		const result = await replaceStaleStacks(checkout, wanted, [runtime], {
			verbose: false,
		});

		expect(downs).toEqual([
			{
				root,
				projectName: "bliss-t3-e144b332",
				removeVolumes: false,
				verbose: false,
				signal: undefined,
			},
		]);
		expect(result.replaced.map((stack) => stack.projectName)).toEqual([
			"bliss-t3-e144b332",
		]);
		expect(readRemovals().map((record) => record.projectName)).toEqual([
			"bliss-t3-e144b332",
		]);
	});

	it("never touches a stack of another checkout root", async () => {
		const { runtime, downs } = stackRuntime(new Map([[13379, otherCheckout]]));

		const result = await replaceStaleStacks(checkout, wanted, [runtime], {
			verbose: false,
		});

		expect(downs).toEqual([]);
		expect(result).toEqual({ replaced: [], kept: [] });
	});

	it("never touches a project another checkout's containers share", async () => {
		const { runtime, downs } = stackRuntime(new Map([[13379, staleRedis]]), {
			extra: [{ project: "bliss-t3-e144b332", root: "/work/main" }],
		});

		const result = await replaceStaleStacks(checkout, wanted, [runtime], {
			verbose: false,
		});

		expect(downs).toEqual([]);
		expect(result.kept.map(({ stack }) => stack.projectName)).toEqual([
			"bliss-t3-e144b332",
		]);
	});

	it("leaves a stack a live run still uses", async () => {
		// This test process is the live run of the old config.
		await publishRun(
			buildRunEntry({
				sessionId: "old-config",
				projectPrefix: "bliss",
				projectName: "bliss-t3-e144b332",
				root,
				isWorktree: true,
			}),
		);
		const { runtime, downs } = stackRuntime(new Map([[13379, staleRedis]]));

		const result = await replaceStaleStacks(checkout, wanted, [runtime], {
			verbose: false,
		});

		expect(downs).toEqual([]);
		expect(result.kept.map(({ stack }) => stack.projectName)).toEqual([
			"bliss-t3-e144b332",
		]);
	});

	it("downs each stale stack through the runtime that reported it", async () => {
		const docker = stackRuntime(new Map());
		const apple = stackRuntime(new Map([[13379, staleRedis]]), {
			name: "apple",
		});

		await replaceStaleStacks(
			checkout,
			wanted,
			[docker.runtime, apple.runtime],
			{ verbose: false },
		);

		expect(docker.downs).toEqual([]);
		expect(apple.downs.map((request) => request.projectName)).toEqual([
			"bliss-t3-e144b332",
		]);
	});
});

describe("assertServicePortsClaimable", () => {
	// A port nothing on the machine listens on: the listener reading is real.
	const port = 1;

	it("names a stale stack of this checkout and the command that removes it", async () => {
		const { runtime } = stackRuntime(new Map([[port, staleRedis]]));

		const failure = assertServicePortsClaimable(
			runtime,
			resolveServices({ redis: { port: 6379 } }),
			{ redis: port },
			{ ...checkout, projectName: "budget-app-t3-e144b332" },
		);

		await expect(failure).rejects.toThrow(
			"a stale stack of this checkout, left under the project name its config used before. Remove it with `docker compose -p bliss-t3-e144b332 down` (its volumes are kept), or start with `buncargo dev --replace-stale`",
		);
	});

	it("reports a stack of another checkout as a plain conflict", async () => {
		const { runtime } = stackRuntime(new Map([[port, otherCheckout]]));

		const failure = assertServicePortsClaimable(
			runtime,
			resolveServices({ redis: { port: 6379 } }),
			{ redis: port },
			{ ...checkout, projectName: "budget-app-t3-e144b332" },
		);

		await expect(failure).rejects.toThrow(
			/^port 1 held by container bliss-t3-other-redis-1 \(project bliss-t3-other\)$/,
		);
	});
});
