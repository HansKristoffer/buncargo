import { describe, expect, it } from "bun:test";
import { getComposeArgs } from "./compose-command";

describe("getComposeArgs", () => {
	it("includes compose file and project name", () => {
		expect(
			getComposeArgs({
				composeFile: ".buncargo/docker-compose.generated.yml",
				projectName: "myapp-test",
			}),
		).toEqual([
			"compose",
			"-f",
			".buncargo/docker-compose.generated.yml",
			"-p",
			"myapp-test",
		]);
	});

	it("names the project even without a compose file", () => {
		expect(getComposeArgs({ projectName: "myapp-test" })).toEqual([
			"compose",
			"-p",
			"myapp-test",
		]);
	});

	it("keeps a path with spaces as one argument", () => {
		expect(
			getComposeArgs({
				projectName: "app",
				composeFile: "/My Projects/app/compose.yml",
			}),
		).toEqual(["compose", "-f", "/My Projects/app/compose.yml", "-p", "app"]);
	});

	it("will not build a command without a project", () => {
		// @ts-expect-error: a compose command without -p acts on whatever
		// project the working directory resolves to.
		getComposeArgs({ composeFile: "compose.yml" });
	});
});
