import { afterEach, describe, expect, it } from "bun:test";
import { buncargoContainersOf } from "../container-runtime/containers";
import { isContainerUp } from "../container-runtime/inventory";
import { listDockerContainersAsync } from "./containers";
import { dockerListLine, fakeDocker } from "./fake-docker.testing";

const fakes: ReturnType<typeof fakeDocker>[] = [];
afterEach(() => {
	for (const fake of fakes.splice(0)) fake.remove();
});

/** The buncargo containers in a Docker listing of `lines`. */
async function inventoryOf(...lines: string[]) {
	const fake = fakeDocker({ ps: { stdout: `${lines.join("\n")}\n` } });
	fakes.push(fake);
	const listed = await listDockerContainersAsync(fake.binary);
	return buncargoContainersOf(listed, "docker");
}

describe("a Docker listing as the inventory", () => {
	it("reads the state and the human status as separate columns", async () => {
		const [container] = await inventoryOf(
			dockerListLine({
				id: "abc123",
				name: "gey-main-postgres-1",
				status: "Up 3 minutes (healthy)",
				ports: "0.0.0.0:5433->5432/tcp",
				project: "gey-main",
				root: "/repo",
				worktree: "t3code-1c22f5fa",
				service: "postgres",
			}),
		);
		expect(container).toEqual({
			id: "abc123",
			name: "gey-main-postgres-1",
			state: "running",
			status: "Up 3 minutes (healthy)",
			ports: "0.0.0.0:5433->5432/tcp",
			project: "gey-main",
			root: "/repo",
			worktree: "t3code-1c22f5fa",
			service: "postgres",
			runtime: "docker",
		});
		expect(container && isContainerUp(container)).toBe(true);
	});

	it("reports an exited container as down however its status reads", async () => {
		const [container] = await inventoryOf(
			dockerListLine({
				id: "abc123",
				state: "exited",
				status: "Up 2 hours ago",
				project: "gey-main",
			}),
		);
		expect(container?.state).toBe("exited");
		expect(container && isContainerUp(container)).toBe(false);
	});

	it("skips a container with no project label", async () => {
		expect(await inventoryOf(dockerListLine({ id: "abc123" }))).toEqual([]);
	});
});
