import { describe, expect, it } from "bun:test";
import { getComposeArg, getComposeCommandPrefix } from "./runtime";

describe("getComposeArg", () => {
	it("returns empty string when compose file is not provided", () => {
		expect(getComposeArg()).toBe("");
	});

	it("returns quoted -f arg when compose file is provided", () => {
		expect(getComposeArg(".buncargo/docker-compose.generated.yml")).toBe(
			'-f ".buncargo/docker-compose.generated.yml"',
		);
	});
});

describe("getComposeCommandPrefix", () => {
	it("includes compose file and project name", () => {
		expect(
			getComposeCommandPrefix({
				composeFile: ".buncargo/docker-compose.generated.yml",
				projectName: "myapp-test",
			}),
		).toBe(
			'docker compose -f ".buncargo/docker-compose.generated.yml" -p myapp-test',
		);
	});

	it("omits optional args when not provided", () => {
		expect(getComposeCommandPrefix()).toBe("docker compose");
	});
});
