import { describe, expect, it } from "bun:test";
import { buildComposeModel } from "../docker-compose";
import type { ComposeDocument, ServiceConfig } from "../types";
import type { AppleCliResult, AppleContainerCli } from "./cli";
import { appleDown, appleUp } from "./lifecycle";
import { buildAppleRunPlan, CONFIG_HASH_LABEL } from "./run-plan";

const IDENTITY = { projectName: "gey-main", root: "/repo", worktree: null };

function modelFor(services: Record<string, ServiceConfig>): ComposeDocument {
	return buildComposeModel(services, undefined, IDENTITY);
}

interface RecordingCli extends AppleContainerCli {
	calls: string[][];
}

/**
 * A CLI stub whose `ls` output is supplied per test, so lifecycle decisions can
 * be driven without a runtime.
 */
function recordingCli(
	lsRecords: unknown[] = [],
	/** Subcommands that should fail, with the stderr they fail with. */
	failures: Record<string, string> = {},
): RecordingCli {
	const calls: string[][] = [];
	const cli: RecordingCli = {
		calls,
		binary: "container",
		found: true,
		run(args): AppleCliResult {
			calls.push(args);
			const failure = args[0] ? failures[args[0]] : undefined;
			if (failure !== undefined) {
				return { ok: false, exitCode: 1, stdout: "", stderr: failure };
			}
			const stdout = args[0] === "ls" ? JSON.stringify(lsRecords) : "";
			return { ok: true, exitCode: 0, stdout, stderr: "" };
		},
	};
	return cli;
}

function record(
	id: string,
	state: string,
	labels: Record<string, string>,
): unknown {
	return { status: state, configuration: { id, labels } };
}

function upRequest(model: ComposeDocument, serviceNames: string[]) {
	return {
		root: "/repo",
		projectName: "gey-main",
		envVars: {},
		model,
		serviceNames,
		verbose: false,
	};
}

function subcommands(cli: RecordingCli): string[] {
	return cli.calls.map((call) => call.slice(0, 2).join(" "));
}

describe("appleUp", () => {
	it("creates named volumes before running the service", () => {
		const cli = recordingCli();
		appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		const volumeCreate = cli.calls.findIndex(
			(call) => call[0] === "volume" && call[1] === "create",
		);
		const run = cli.calls.findIndex((call) => call[0] === "run");
		expect(volumeCreate).toBeGreaterThanOrEqual(0);
		expect(run).toBeGreaterThan(volumeCreate);
		expect(cli.calls[volumeCreate]?.[2]).toBe("gey-main-postgres_data");
	});

	it("reads the inventory once no matter how many services start", () => {
		const cli = recordingCli();
		appleUp(
			cli,
			upRequest(
				modelFor({
					postgres: { port: 5432 },
					redis: { port: 6379 },
					mailpit: { port: 8025 },
				}),
				["postgres", "redis", "mailpit"],
			),
		);

		expect(cli.calls.filter((call) => call[0] === "ls")).toHaveLength(1);
	});

	it("leaves a running container with a matching config hash alone", () => {
		const plan = buildAppleRunPlan({
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			root: "/repo",
		});
		const hash = plan.services[0]?.configHash ?? "";
		const cli = recordingCli([
			record("gey-main-postgres", "running", { [CONFIG_HASH_LABEL]: hash }),
		]);

		appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		expect(subcommands(cli)).not.toContain("run --detach");
		expect(subcommands(cli)).not.toContain("delete --force");
	});

	it("starts a stopped container instead of recreating it", () => {
		const plan = buildAppleRunPlan({
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			root: "/repo",
		});
		const hash = plan.services[0]?.configHash ?? "";
		const cli = recordingCli([
			record("gey-main-postgres", "stopped", { [CONFIG_HASH_LABEL]: hash }),
		]);

		appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		expect(
			cli.calls.some(
				(call) => call[0] === "start" && call[1] === "gey-main-postgres",
			),
		).toBe(true);
		expect(cli.calls.some((call) => call[0] === "run")).toBe(false);
	});

	it("recreates a container whose config hash drifted", () => {
		const cli = recordingCli([
			record("gey-main-postgres", "running", {
				[CONFIG_HASH_LABEL]: "stale-hash",
			}),
		]);

		appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		expect(
			cli.calls.some(
				(call) => call[0] === "delete" && call.includes("gey-main-postgres"),
			),
		).toBe(true);
		expect(cli.calls.some((call) => call[0] === "run")).toBe(true);
	});
});

describe("appleDown", () => {
	it("stops running containers then deletes every one in the project", () => {
		const cli = recordingCli([
			record("gey-main-postgres", "running", {
				"buncargo.project": "gey-main",
			}),
			record("gey-main-redis", "stopped", { "buncargo.project": "gey-main" }),
			record("other-postgres", "running", { "buncargo.project": "other" }),
		]);

		appleDown(cli, {
			root: "/repo",
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			verbose: false,
		});

		const stop = cli.calls.find((call) => call[0] === "stop");
		const remove = cli.calls.find((call) => call[0] === "delete");
		expect(stop).toEqual(["stop", "gey-main-postgres"]);
		expect(remove).toEqual([
			"delete",
			"--force",
			"gey-main-postgres",
			"gey-main-redis",
		]);
	});

	it("throws rather than reporting success when a stop fails", () => {
		const cli = recordingCli(
			[
				record("gey-main-postgres", "running", {
					"buncargo.project": "gey-main",
				}),
			],
			{ stop: "internal error" },
		);

		expect(() =>
			appleDown(cli, {
				root: "/repo",
				projectName: "gey-main",
				verbose: false,
			}),
		).toThrow(/stop containers gey-main-postgres failed/);
	});

	it("tolerates a container that vanished between listing and deleting", () => {
		const cli = recordingCli(
			[
				record("gey-main-postgres", "stopped", {
					"buncargo.project": "gey-main",
				}),
			],
			{ delete: "Error: no such container" },
		);

		expect(() =>
			appleDown(cli, {
				root: "/repo",
				projectName: "gey-main",
				verbose: false,
			}),
		).not.toThrow();
	});

	it("needs no model to tear a project down", () => {
		const cli = recordingCli([
			record("gey-main-redis", "running", { "buncargo.project": "gey-main" }),
		]);

		// The detached watchdog runner has no config in scope.
		appleDown(cli, { root: "/repo", projectName: "gey-main", verbose: false });

		expect(cli.calls).toContainEqual(["delete", "--force", "gey-main-redis"]);
	});

	it("refuses to remove volumes without a model to name them", () => {
		expect(() =>
			appleDown(recordingCli(), {
				root: "/repo",
				projectName: "gey-main",
				removeVolumes: true,
				verbose: false,
			}),
		).toThrow(/without the compose model/);
	});

	it("removes the project's named volumes only with removeVolumes", () => {
		const withReset = recordingCli();
		appleDown(withReset, {
			root: "/repo",
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			removeVolumes: true,
			verbose: false,
		});
		expect(withReset.calls).toContainEqual([
			"volume",
			"delete",
			"gey-main-postgres_data",
		]);

		const withoutReset = recordingCli();
		appleDown(withoutReset, {
			root: "/repo",
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			verbose: false,
		});
		expect(withoutReset.calls.some((call) => call[0] === "volume")).toBe(false);
	});
});
