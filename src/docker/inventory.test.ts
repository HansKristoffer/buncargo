import { describe, expect, it } from "bun:test";
import { isContainerUp } from "../container-runtime/inventory";
import { dockerListLine } from "./fake-docker.testing";
import { parseDockerContainerLine } from "./inventory";

describe("parseDockerContainerLine", () => {
	it("reads the state and the human status as separate columns", () => {
		const container = parseDockerContainerLine(
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

	it("reports an exited container as down however its status reads", () => {
		const container = parseDockerContainerLine(
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

	it("skips a line with no id or no project label", () => {
		expect(parseDockerContainerLine("")).toBeNull();
		expect(
			parseDockerContainerLine(dockerListLine({ id: "abc123" })),
		).toBeNull();
	});
});
