import { describe, expect, it } from "bun:test";
import { parseDockerVolumeLine } from "./volumes";

describe("parseDockerVolumeLine", () => {
	it("reads a named volume and its compose project", () => {
		expect(parseDockerVolumeLine("gey-main_postgres_data\tgey-main")).toEqual({
			name: "gey-main_postgres_data",
			project: "gey-main",
			runtime: "docker",
		});
	});

	it("keeps a named volume with no project, for prune to leave alone", () => {
		expect(parseDockerVolumeLine("some-named-volume\t")).toEqual({
			name: "some-named-volume",
			runtime: "docker",
		});
	});

	it("drops anonymous volumes, which are never a compose file's", () => {
		// A working machine has hundreds of these; listing them buried the
		// handful of named volumes that prune can actually reason about.
		const anonymous = "a".repeat(64);
		expect(parseDockerVolumeLine(`${anonymous}\t`)).toBeNull();
		expect(parseDockerVolumeLine("")).toBeNull();
	});
});
