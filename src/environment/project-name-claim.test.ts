import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_PROJECT_SUFFIX } from "../core/ports";
import { createDevEnvironment } from "./create-dev-environment";

// The claims live in ~/.buncargo: never the developer's. The selection below
// has no services, so no container runtime is asked anything.
const originalHome = process.env.HOME;
const originalOffset = process.env.BUNCARGO_PORT_OFFSET;
let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "buncargo-project-name-"));
	process.env.HOME = join(scratch, "home");
	delete process.env.BUNCARGO_PORT_OFFSET;
});
afterEach(() => {
	process.env.HOME = originalHome;
	if (originalOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
	else process.env.BUNCARGO_PORT_OFFSET = originalOffset;
	rmSync(scratch, { recursive: true, force: true });
});

/** A checkout whose directory is named `app`, under its own parent. */
function checkout(parent: string) {
	const root = join(scratch, parent, "app");
	mkdirSync(root, { recursive: true });
	const env = createDevEnvironment(
		{
			projectPrefix: "lullu",
			services: { postgres: { port: 5432 } },
			apps: { web: { port: 3000, devCommand: false } },
			options: { verbose: false },
		},
		{ root, containerRuntime: "runtime-lookup-must-not-run" },
	);
	return { root, env };
}

it("refuses to start a second checkout under a project name another one claims, and its ci stack", async () => {
	const first = checkout("runner-1");
	const second = checkout("runner-2");
	expect(second.env.projectName).toBe(first.env.projectName);

	await first.env.prepareStartAsync(["web"]);
	await first.env.withSuffix(CI_PROJECT_SUFFIX).prepareStartAsync(["web"]);

	await expect(
		second.env.start({ onlyApps: ["web"], startServers: false }),
	).rejects.toThrow(
		`${second.root} would run under Compose project lullu-app, which ${first.root} already uses`,
	);
	await expect(
		second.env
			.withSuffix(CI_PROJECT_SUFFIX)
			.start({ onlyApps: ["web"], startServers: false }),
	).rejects.toThrow(
		`would run under Compose project lullu-app-ci, which ${first.root} (ci) already uses`,
	);
	expect(existsSync(join(second.root, ".buncargo", "ports.json"))).toBe(false);
});
