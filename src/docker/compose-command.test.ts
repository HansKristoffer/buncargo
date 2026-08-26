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

	it("omits optional args when not provided", () => {
		expect(getComposeArgs()).toEqual(["compose"]);
	});

	it("keeps a path with spaces as one argument", () => {
		expect(
			getComposeArgs({ composeFile: "/My Projects/app/compose.yml" }),
		).toEqual(["compose", "-f", "/My Projects/app/compose.yml"]);
	});
});
