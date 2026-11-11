import { describe, expect, it } from "bun:test";
import { fakeDocker } from "./fake-docker.testing";
import { listDockerVolumes, parseDockerVolumeLine } from "./volumes";

describe("listDockerVolumes", () => {
	it("throws when Docker cannot list, rather than answering none", async () => {
		// An empty answer read as "no volume left", which let the sweep retire
		// the claim that names a deleted checkout's volumes.
		const fake = fakeDocker({
			volume: { stderr: "Cannot connect to the Docker daemon", exitCode: 1 },
		});
		try {
			await expect(listDockerVolumes(fake.binary)).rejects.toThrow(
				"Cannot connect to the Docker daemon",
			);
		} finally {
			fake.remove();
		}
	});
});

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
