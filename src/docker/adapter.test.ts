import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerRuntimeAdapter, orbstackDockerSocket } from "./adapter";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A `docker` that records its argv and lists one buncargo container. */
function fakeDocker() {
	const root = mkdtempSync(join(tmpdir(), "buncargo-docker-adapter-"));
	roots.push(root);
	const log = join(root, "calls.jsonl");
	const binary = join(root, "docker");
	const row = [
		"abc123",
		"gey-main-postgres-1",
		"running",
		"Up 1 minute",
		"0.0.0.0:5433->5432/tcp",
		"gey-main",
		"/repo",
		"",
		"postgres",
	].join("\\t");
	writeFileSync(
		binary,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in *"ps -a"*) printf '${row}\\n';; esac\n`,
	);
	chmodSync(binary, 0o700);
	return {
		binary,
		calls: () => readFileSync(log, "utf8").trim().split("\n"),
	};
}

describe("the OrbStack runtime", () => {
	it("pins every command to OrbStack's socket and labels what it lists", () => {
		const { binary, calls } = fakeDocker();
		const adapter = dockerRuntimeAdapter({ binary, engine: "orbstack" });

		expect(adapter.name).toBe("orbstack");
		expect(adapter.displayName).toBe("OrbStack");
		expect(adapter.list().map((container) => container.runtime)).toEqual([
			"orbstack",
		]);
		expect(calls()[0]).toStartWith(
			`--host unix://${orbstackDockerSocket()} ps `,
		);
	});

	it("leaves the Docker runtime on the context's engine", () => {
		const { binary, calls } = fakeDocker();
		const adapter = dockerRuntimeAdapter({ binary });

		expect(adapter.name).toBe("docker");
		expect(adapter.list().map((container) => container.runtime)).toEqual([
			"docker",
		]);
		expect(calls()[0]).toStartWith("ps ");
	});
});
