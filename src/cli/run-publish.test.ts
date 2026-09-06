import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentity } from "../core/process-identity";
import { loadRuns, readLiveRuns } from "../core/run-registry";
import { handleStop, stopService } from "./commands/stop";
import {
	markApps,
	publishCurrentRun,
	type RunSource,
	readGitBranch,
	withdrawCurrentRun,
} from "./run-publish";
import { parseStopArgs } from "./stop-flags";

let root: string;
let savedHome: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-publish-"));
	savedHome = process.env.HOME;
	process.env.HOME = root;
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});
function source(): RunSource {
	return {
		projectPrefix: "fixture",
		projectName: "fixture",
		root,
		isWorktree: false,
		ports: { db: 5432, other: 6379, web: 3000 },
		urls: {},
		loopbackUrls: {},
		publicUrls: {},
		hosts: null,
		services: {
			db: {
				port: 5432,
				serviceName: "database",
				docker: { image: "postgres" },
			},
			other: { port: 6379 },
		},
		containerRuntime: "docker",
		containerRuntimeBinary: join(root, "custom docker"),
		resolvePrimaryApp: () => "web",
	};
}

describe("published run ownership", () => {
	it("publishes selected services with exact alias, runtime binary and process identity", async () => {
		const run = await publishCurrentRun(source(), {
			apps: { web: { port: 3000, devCommand: "bun dev" } },
			serviceNames: ["db"],
		});
		expect(run?.sessionId).toBeDefined();
		expect(run?.processIdentity).toBe(readProcessIdentity(process.pid));
		expect(run?.services).toHaveLength(1);
		expect(run?.services[0]?.container).toMatchObject({
			runtime: "docker",
			service: "database",
			binary: join(root, "custom docker"),
		});
		await Promise.all([
			markApps(root, ["web"], "stopped"),
			markApps(root, ["web"], "ready"),
		]);
		expect((await loadRuns())[0]?.apps[0]?.status).toBe("stopped");
		await withdrawCurrentRun(root);
		expect(await loadRuns()).toEqual([]);
	});
	it("reads a main checkout git branch", () => {
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		expect(readGitBranch(root)).toBe("main");
	});
	it("parses session selection without treating the id as a target", () => {
		expect(
			parseStopArgs(["web", "--root", root, "--run", "abc"]),
		).toMatchObject({ names: ["web"], run: "abc", errors: [] });
	});
	it("refuses a mismatched recorded app pid identity before signalling", async () => {
		const run = await publishCurrentRun(source(), {
			apps: { web: { port: 3000, devCommand: "bun dev" } },
			serviceNames: [],
		});
		if (!run) throw new Error("run not published");
		const { patchRun } = await import("../core/run-registry");
		await patchRun(
			root,
			process.pid,
			{
				apps: [
					{
						name: "web",
						pid: process.pid,
						processIdentity: "stale",
						status: "ready",
					},
				],
			},
			{ sessionId: run.sessionId },
		);
		expect(
			await handleStop(["web", "--root", root, "--run", run.sessionId ?? ""]),
		).toBe(3);
		expect(await readLiveRuns()).toHaveLength(1);
	});
	it("stops exactly an aliased service through its recorded binary and updates status", async () => {
		const env = source();
		const binary = env.containerRuntimeBinary ?? "";
		const calls = join(root, "calls.jsonl");
		writeFileSync(
			binary,
			`#!${process.execPath}\nimport { appendFileSync } from "node:fs"; const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n"); if (args[0] === "ps") console.log("owned\\tfixture-database-1\\tUp\\t\\tfixture\\t${root}\\t\\tdatabase\\nforeign\\tfixture-other-1\\tUp\\t\\tfixture\\t${root}\\t\\tother");`,
		);
		chmodSync(binary, 0o755);
		const run = await publishCurrentRun(env, {
			apps: {},
			serviceNames: ["db"],
		});
		const service = run?.services[0];
		if (!run || !service) throw new Error("service not published");
		expect(await stopService(run, service)).toBe(0);
		const args = readFileSync(calls, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(args).toContainEqual(["stop", "owned"]);
		expect((await loadRuns())[0]?.services[0]?.status).toBe("stopped");
	});
});
