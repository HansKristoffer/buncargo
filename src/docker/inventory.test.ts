import { describe, expect, it } from "bun:test";
import { isContainerUp } from "../container-runtime/inventory";
import { parseDockerContainerLine } from "./inventory";

/** The columns `LIST_ARGS` asks for, in order. */
function line(...columns: string[]): string {
	return columns.join("\t");
}

describe("parseDockerContainerLine", () => {
	it("reads the state and the human status as separate columns", () => {
		const container = parseDockerContainerLine(
			line(
				"abc123",
				"gey-main-postgres-1",
				"running",
				"Up 3 minutes (healthy)",
				"0.0.0.0:5433->5432/tcp",
				"gey-main",
				"/repo",
				"t3code-1c22f5fa",
				"postgres",
			),
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
			line(
				"abc123",
				"gey-main-db-1",
				"exited",
				"Exited (0) 2 hours ago",
				"",
				"gey-main",
				"/repo",
				"",
				"db",
			),
		);
		expect(container?.state).toBe("exited");
		expect(container && isContainerUp(container)).toBe(false);
	});

	it("skips a line with no id or no project label", () => {
		expect(parseDockerContainerLine("")).toBeNull();
		expect(
			parseDockerContainerLine(line("abc123", "n", "running", "Up", "", "")),
		).toBeNull();
	});
});
