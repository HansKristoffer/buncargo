import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offsetClaimKey, readOffsetClaims } from "../core/offset-claims";
import { PORT_OFFSET_STEP, readPortsLockfile } from "../core/port-allocation";
import { createDevEnvironment } from "../environment/create-dev-environment";

// `buncargo prisma` starts the database outside a run. A CI runner's checkout
// took its hashed block while another OS user's project, with claims in a
// `~/.buncargo` this one cannot see, published the same Postgres port.

const originalHome = process.env.HOME;
const originalOffset = process.env.BUNCARGO_PORT_OFFSET;
let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "buncargo-prisma-ports-"));
	process.env.HOME = join(scratch, "home");
	delete process.env.BUNCARGO_PORT_OFFSET;
});
afterEach(() => {
	process.env.HOME = originalHome;
	if (originalOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
	else process.env.BUNCARGO_PORT_OFFSET = originalOffset;
	rmSync(scratch, { recursive: true, force: true });
});

const BASE_PORT = 15432;

/**
 * A `docker` that lists one container publishing `port` for `project`, and
 * fails everything else past `version`: a start stops at `compose up`, after
 * the allocation and the port preflight.
 */
function fakeDocker(container?: { port: number; project: string }): string {
	const docker = join(scratch, "docker");
	const ps = container
		? `printf '%s\\t%s\\t%s\\t%s\\n' f00 ${container.project}-postgres-1 '0.0.0.0:${container.port}->5432/tcp' ${container.project}`
		: "true";
	writeFileSync(
		docker,
		`#!/bin/sh\ncase "$1" in\n  ps) ${ps} ;;\n  version) echo 27.0.0 ;;\n  *) exit 1 ;;\nesac\n`,
		{ mode: 0o700 },
	);
	return docker;
}

function checkout(container?: { port: number; project: string }) {
	const root = join(scratch, "app");
	mkdirSync(root, { recursive: true });
	const env = createDevEnvironment(
		{
			projectPrefix: "gey-worker-14",
			services: { postgres: { port: BASE_PORT } },
			// A run's selection then differs from the database's alone.
			apps: { web: { port: BASE_PORT - 2000, devCommand: false } },
			prisma: {},
			docker: { runtime: "docker", binary: fakeDocker(container) },
			options: { verbose: false },
		},
		{ root },
	);
	const { prisma } = env;
	if (!prisma) throw new Error("prisma is configured");
	return { root, env, prisma };
}

it("starts the database on the next free block when another project's container publishes the hashed port", async () => {
	const hashed = checkout().env.portOffset;
	const { root, env, prisma } = checkout({
		port: BASE_PORT + hashed,
		project: "bliss-t3-ae4f38ef",
	});

	const failure = await prisma.ensureDatabase().catch((error) => error);

	expect(String(failure)).not.toContain("held by container");
	expect(env.portOffset).toBe(hashed + PORT_OFFSET_STEP);
	expect(env.ports.postgres).toBe(BASE_PORT + hashed + PORT_OFFSET_STEP);
	expect(readPortsLockfile(root)?.offset).toBe(hashed + PORT_OFFSET_STEP);
	expect(readOffsetClaims()[offsetClaimKey(root)]?.offset).toBe(
		hashed + PORT_OFFSET_STEP,
	);
});

it("keeps its offset when the hashed port is its own container's", async () => {
	const unprobed = checkout().env;
	const hashed = unprobed.portOffset;
	const { env, prisma } = checkout({
		port: BASE_PORT + hashed,
		project: unprobed.projectName,
	});

	await prisma.ensureDatabase().catch(() => {});

	expect(env.portOffset).toBe(hashed);
	expect(env.ports.postgres).toBe(BASE_PORT + hashed);
});

it("fails on the foreign container under BUNCARGO_PORT_OFFSET rather than moving", async () => {
	process.env.BUNCARGO_PORT_OFFSET = "2800";
	const { env, prisma } = checkout({
		port: BASE_PORT + 2800,
		project: "bliss-t3-ae4f38ef",
	});

	await expect(prisma.ensureDatabase()).rejects.toThrow(
		`port ${BASE_PORT + 2800} held by container bliss-t3-ae4f38ef-postgres-1 (project bliss-t3-ae4f38ef)`,
	);
	expect(env.portOffset).toBe(2800);
});

it("leaves an allocation already made where it is", async () => {
	const { env, prisma } = checkout();
	await env.prepareStartAsync();
	const offset = env.portOffset;
	fakeDocker({ port: BASE_PORT + offset, project: "bliss-t3-ae4f38ef" });

	await expect(prisma.ensureDatabase()).rejects.toThrow(
		`port ${BASE_PORT + offset} held by container bliss-t3-ae4f38ef-postgres-1`,
	);
	expect(env.portOffset).toBe(offset);
});
