import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offsetClaimKey, readOffsetClaims } from "../core/offset-claims";
import { CI_PROJECT_SUFFIX } from "../core/ports";
import { CI_ENV_VARS } from "../core/runtime-flags";
import { createDevEnvironment } from "./create-dev-environment";

// A CI runner's directory persists between jobs, and a claim lives as long as
// its directory: claims of throwaway environments filled every block of the
// machine and stayed. Its teardown gives the block back; a developer's dev
// checkout keeps its block while it is stopped.

const saved = Object.fromEntries(
	["HOME", "BUNCARGO_PORT_OFFSET", ...CI_ENV_VARS].map((name) => [
		name,
		process.env[name],
	]),
);
let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "buncargo-throwaway-claims-"));
	process.env.HOME = join(scratch, "home");
	delete process.env.BUNCARGO_PORT_OFFSET;
	for (const name of CI_ENV_VARS) delete process.env[name];
});
afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
});

/** A `docker` with no containers, on which every command succeeds. */
function fakeDocker(): string {
	const docker = join(scratch, "docker");
	writeFileSync(
		docker,
		`#!/bin/sh\ncase "$1" in\n  version) echo 27.0.0 ;;\n  *) true ;;\nesac\n`,
		{ mode: 0o700 },
	);
	return docker;
}

function checkout() {
	const root = join(scratch, "runner-9", "app");
	mkdirSync(root, { recursive: true });
	const env = createDevEnvironment(
		{
			projectPrefix: "gey",
			services: { postgres: { port: 5432 } },
			docker: { runtime: "docker", binary: fakeDocker() },
			options: { verbose: false },
		},
		{ root },
	);
	return { root, env };
}

it("gives a suffixed environment's block back when it is stopped", async () => {
	const { root, env } = checkout();
	const ci = env.withSuffix(CI_PROJECT_SUFFIX);
	await ci.prepareStartAsync();
	const key = offsetClaimKey(root, CI_PROJECT_SUFFIX);
	expect(readOffsetClaims()[key]).toBeDefined();

	await ci.stop({ verbose: false, removeVolumes: true });

	expect(readOffsetClaims()[key]).toBeUndefined();
	// Its next start claims again.
	await ci.prepareStartAsync();
	expect(readOffsetClaims()[key]).toBeDefined();
});

it("gives a dev environment's block back when it is stopped in CI", async () => {
	process.env.CI = "true";
	const { root, env } = checkout();
	await env.prepareStartAsync();
	expect(readOffsetClaims()[root]).toBeDefined();

	await env.stop({ verbose: false });

	expect(readOffsetClaims()[root]).toBeUndefined();
});

it("keeps a developer's dev block claimed while it is stopped", async () => {
	const { root, env } = checkout();
	await env.prepareStartAsync();
	const { offset } = readOffsetClaims()[root] ?? {};

	await env.stop({ verbose: false });

	expect(readOffsetClaims()[root]?.offset).toBe(offset);
});
