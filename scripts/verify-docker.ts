import { observeStartupMetrics } from "../src/core/startup-metrics";
/** Disposable real-runtime contract check, run only by the dedicated CI job. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment, defineDevConfig } from "../src";

const root = mkdtempSync(join(tmpdir(), "buncargo-docker-contract-"));
const projectPrefix = `buncargo-ci-${process.pid}`;
function environment(revision: string) {
	return createDevEnvironment(
		defineDevConfig({
			projectPrefix,
			services: {
				redis: {
					port: 6379,
					healthCheck: "redis-cli",
					docker: {
						image: "redis:7-alpine",
						environment: { CONTRACT_REVISION: revision },
					},
				},
			},
			apps: {
				cli: { port: 3000, devCommand: false, requiredServices: ["redis"] },
			},
			options: {
				worktreeIsolation: false,
				autoShutdown: false,
				verbose: false,
			},
		}),
		{ root, containerRuntime: "docker" },
	);
}
const first = environment("one");
function containerId(): string {
	const result = Bun.spawnSync(
		[
			"docker",
			"ps",
			"-aq",
			"--filter",
			`label=com.docker.compose.project=${first.projectName}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const ids = result.stdout.toString().trim().split("\n").filter(Boolean);
	assert.equal(
		ids.length,
		1,
		"Expected exactly the disposable selected service",
	);
	const id = ids[0];
	assert(id);
	return id;
}
const decisions: string[] = [];
const stopObserving = observeStartupMetrics((name) => {
	if (name.startsWith("container ")) decisions.push(name);
});
try {
	await first.start({ startServers: false, verbose: false });
	const original = containerId();
	await first.start({ startServers: false, verbose: false });
	assert.equal(containerId(), original, "Warm start must reuse its container");
	assert.deepEqual(
		decisions,
		["container reconcile", "container reuse"],
		"Warm start must skip the runtime up operation",
	);
	const changed = environment("two");
	await changed.start({ startServers: false, verbose: false });
	assert.notEqual(
		containerId(),
		original,
		"Changed Compose environment must reconcile",
	);
	console.log("Docker start/reuse/change contract passed");
} finally {
	stopObserving();
	await first.stop({ verbose: false, removeVolumes: true });
	rmSync(root, { recursive: true, force: true });
}
