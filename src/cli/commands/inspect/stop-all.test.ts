import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fakeRuntime,
	listedAs,
} from "../../../container-runtime/fake-runtime.testing";
import type { ContainerDownRequest } from "../../../container-runtime/types";
import { claimOffset } from "../../../core/offset-claims";
import { readRemovals } from "../../../core/removal-log";
import { publishRun } from "../../../core/run-registry";
import { runEntry } from "../../../core/run-registry.testing";
import { useTempHome } from "../../../core/test-env.testing";
import type { BuncargoContainer } from "../../../types";
import { stopAllBuncargoEnvironments } from "./stop-all";

// The registry and claims decide which stacks are this user's, so they come
// from a home of each test's own; the runtimes are stubs.
const home = useTempHome();

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
	const runtime = fakeRuntime({
		name,
		displayName: name,
		containers: async () => containers.map(listedAs),
		down: async (request: ContainerDownRequest) => {
			downs.push(request);
		},
	});
	return { runtime, downs };
}

function claim(projectName: string, root: string) {
	claimOffset({ root, offset: 100, ports: [], projectName });
}

describe("dev --down --all", () => {
	it("removes every stack of this user's once, through the runtime that listed it, stopped ones included", async () => {
		claim("gey-main", "/repo");
		claim("lullu-wt", "/wt");
		await publishRun(
			runEntry({
				projectPrefix: "gey",
				projectName: "gey-apple",
				root: "/apple",
			}),
		);
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
		// Each recorded, so the runs that used them can say who took them.
		expect(
			readRemovals().map((record) => [record.projectName, record.runtime]),
		).toEqual([
			["gey-main", "docker"],
			["lullu-wt", "docker"],
			["gey-apple", "apple"],
		]);
	});

	it("leaves stacks no run or claim of this user's names", async () => {
		// Another user's stacks on a shared daemon, or ones whose state was
		// wiped: listed with the command that removes each, never removed.
		claim("gey-main", "/repo");
		claim("gey-other", "/somewhere-else");
		const docker = stubRuntime("docker", [
			container("gey-main", "/repo", "postgres"),
			container("gey-other", "/home/runner/work", "postgres"),
		]);
		const apple = stubRuntime("apple", [
			container("theirs", "/home/runner/apple", "postgres", "apple"),
		]);

		await stopAllBuncargoEnvironments([docker.runtime, apple.runtime]);

		expect(docker.downs.map((request) => request.projectName)).toEqual([
			"gey-main",
		]);
		expect(apple.downs).toEqual([]);
	});

	it("removes nothing when the registry cannot be read", async () => {
		mkdirSync(join(home(), ".buncargo"), { recursive: true });
		writeFileSync(join(home(), ".buncargo", "runs.json"), "{ not json");
		claim("gey-main", "/repo");
		const docker = stubRuntime("docker", [
			container("gey-main", "/repo", "postgres"),
		]);
		await expect(stopAllBuncargoEnvironments([docker.runtime])).rejects.toThrow(
			/nothing was removed/,
		);
		expect(docker.downs).toEqual([]);
	});

	it("does nothing without a runtime or without containers", async () => {
		const docker = stubRuntime("docker", []);
		await stopAllBuncargoEnvironments([]);
		await stopAllBuncargoEnvironments([docker.runtime]);
		expect(docker.downs).toEqual([]);
	});
});
