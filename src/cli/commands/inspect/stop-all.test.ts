import { describe, expect, it } from "bun:test";
import type {
	ContainerDownRequest,
	ContainerRuntimeAdapter,
} from "../../../container-runtime/types";
import type { BuncargoContainer } from "../../../types";
import { stopAllBuncargoEnvironments } from "./stop-all";

function container(
	project: string,
	root: string,
	service: string,
	runtime: "docker" | "apple" = "docker",
): BuncargoContainer {
	return {
		id: `${project}-${service}`,
		name: `${project}-${service}`,
		state: "exited",
		status: "Exited (0) 2 hours ago",
		ports: "",
		project,
		root,
		worktree: "",
		service,
		runtime,
	};
}

function stubRuntime(
	name: "docker" | "apple",
	containers: BuncargoContainer[],
) {
	const downs: ContainerDownRequest[] = [];
	const runtime = {
		name,
		displayName: name,
		isAvailable: () => true,
		list: () => containers,
		down: async (request: ContainerDownRequest) => {
			downs.push(request);
		},
	} as unknown as ContainerRuntimeAdapter;
	return { runtime, downs };
}

describe("dev --down --all", () => {
	it("removes every stack once, through the runtime that listed it, stopped ones included", async () => {
		const docker = stubRuntime("docker", [
			container("gey-main", "/repo", "postgres"),
			container("gey-main", "/repo", "redis"),
			container("lullu-wt", "/wt", "postgres"),
		]);
		const apple = stubRuntime("apple", [
			container("gey-apple", "/apple", "postgres", "apple"),
		]);

		await stopAllBuncargoEnvironments([docker.runtime, apple.runtime]);

		expect(
			docker.downs.map((request) => [request.projectName, request.root]),
		).toEqual([
			["gey-main", "/repo"],
			["lullu-wt", "/wt"],
		]);
		expect(apple.downs.map((request) => request.projectName)).toEqual([
			"gey-apple",
		]);
		expect(docker.downs[0]).toMatchObject({ verbose: false });
	});

	it("does nothing without a runtime or without containers", async () => {
		const docker = stubRuntime("docker", []);
		await stopAllBuncargoEnvironments([]);
		await stopAllBuncargoEnvironments([docker.runtime]);
		expect(docker.downs).toEqual([]);
	});
});
