import {
	afterEach,
	beforeEach,
	expect,
	it,
	setSystemTime,
	spyOn,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimOffset,
	offsetClaimHoldsBlock,
	offsetClaimKey,
	readOffsetClaims,
	withOffsetClaimsLock,
} from "../core/offset-claims";
import { CI_PROJECT_SUFFIX } from "../core/ports";
import * as runRegistry from "../core/run-registry";
import { CI_ENV_VARS } from "../core/runtime-flags";
import { createDevEnvironment } from "./create-dev-environment";

// A CI runner's directory persists between jobs, and a claim lives as long as
// its directory: claims of throwaway environments filled every block of the
// machine and stayed. Its teardown gives the block back and keeps the claim,
// the record of whose project its volumes are; a developer's dev checkout
// keeps its block while it is stopped.

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

/** The claim under `key`: whether it is there, and holds its block. */
function claimState(key: string): "holds" | "released" | "none" {
	const claim = readOffsetClaims()[key];
	if (!claim) return "none";
	return offsetClaimHoldsBlock(claim) ? "holds" : "released";
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

it("gives a suffixed environment's block back when it is stopped, and keeps who owns its project", async () => {
	const { root, env } = checkout();
	const ci = env.withSuffix(CI_PROJECT_SUFFIX);
	await ci.prepareStartAsync();
	const key = offsetClaimKey(root, CI_PROJECT_SUFFIX);
	expect(claimState(key)).toBe("holds");

	await ci.stop({ verbose: false });

	expect(claimState(key)).toBe("released");
	expect(readOffsetClaims()[key]).toMatchObject({
		projectName: ci.projectName,
		root,
	});
	// Its next start claims again.
	await ci.prepareStartAsync();
	expect(claimState(key)).toBe("holds");
});

it("gives a dev environment's block back when it is stopped in CI", async () => {
	process.env.CI = "true";
	const { root, env } = checkout();
	await env.prepareStartAsync();
	expect(claimState(root)).toBe("holds");

	await env.stop({ verbose: false });

	expect(claimState(root)).toBe("released");
});

it("claims a block again for Prisma once a stop gave the last one back", async () => {
	const root = join(scratch, "runner-9", "app");
	mkdirSync(root, { recursive: true });
	const ci = createDevEnvironment(
		{
			projectPrefix: "gey",
			services: { postgres: { port: 5432, healthCheck: false } },
			docker: { runtime: "docker", binary: fakeDocker() },
			prisma: {},
			options: { verbose: false },
		},
		{ root },
	).withSuffix(CI_PROJECT_SUFFIX);
	const key = offsetClaimKey(root, CI_PROJECT_SUFFIX);
	await ci.prepareStartAsync();
	await ci.stop({ verbose: false, removeVolumes: true });
	expect(claimState(key)).toBe("released");

	// Not the released block, which another environment may have claimed since.
	await ci.prisma?.ensureDatabase();
	expect(claimState(key)).toBe("holds");
});

it("keeps a developer's dev block claimed while it is stopped", async () => {
	const { root, env } = checkout();
	await env.prepareStartAsync();
	const { offset } = readOffsetClaims()[root] ?? {};

	await env.stop({ verbose: false });

	expect(readOffsetClaims()[root]?.offset).toBe(offset);
});

it("keeps the block a run claimed while the stop checked for runs", async () => {
	const { root, env } = checkout();
	const ci = env.withSuffix(CI_PROJECT_SUFFIX);
	await ci.prepareStartAsync();
	const key = offsetClaimKey(root, CI_PROJECT_SUFFIX);
	const claimed = readOffsetClaims()[key];
	if (!claimed) throw new Error("no claim");

	// Another job of this directory allocates the block after the stop read
	// the runs, before it has published its own run.
	const readRuns = spyOn(runRegistry, "readAllRuns").mockImplementation(
		async () => {
			setSystemTime(new Date(Date.now() + 60_000));
			withOffsetClaimsLock(() =>
				claimOffset({
					root,
					suffix: CI_PROJECT_SUFFIX,
					offset: claimed.offset,
					ports: claimed.ports,
					projectName: claimed.projectName,
				}),
			);
			setSystemTime();
			return [];
		},
	);
	try {
		await ci.stop({ verbose: false, removeVolumes: true });
	} finally {
		readRuns.mockRestore();
	}

	expect(readOffsetClaims()[key]?.offset).toBe(claimed.offset);
});

it("keeps the block another run of the environment claimed during the teardown", async () => {
	const root = join(scratch, "runner-9", "app");
	mkdirSync(root, { recursive: true });
	const config = {
		projectPrefix: "gey",
		services: { postgres: { port: 5432 } },
		docker: { runtime: "docker" as const, binary: fakeDocker() },
		options: { verbose: false },
	};
	const next = createDevEnvironment(config, { root }).withSuffix(
		CI_PROJECT_SUFFIX,
	);
	// The next job of this directory allocates while this one tears down,
	// before it has published its run.
	const ci = createDevEnvironment(
		{
			...config,
			hooks: {
				beforeStop: async () => {
					setSystemTime(new Date(Date.now() + 60_000));
					try {
						await next.prepareStartAsync();
					} finally {
						setSystemTime();
					}
				},
			},
		},
		{ root },
	).withSuffix(CI_PROJECT_SUFFIX);
	await ci.prepareStartAsync();
	const key = offsetClaimKey(root, CI_PROJECT_SUFFIX);

	await ci.stop({ verbose: false, removeVolumes: true });

	expect(readOffsetClaims()[key]).toBeDefined();
});
