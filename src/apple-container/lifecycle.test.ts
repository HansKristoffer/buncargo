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
	/**
	 * Subcommands that should fail, with the stderr they fail with. A list
	 * fails that many calls in turn, then succeeds.
	 */
	failures: Record<string, string | string[]> = {},
): RecordingCli {
	const calls: string[][] = [];
	const cli: RecordingCli = {
		calls,
		binary: "container",
		found: true,
		run(args): AppleCliResult {
			calls.push(args);
			const configured = args[0] ? failures[args[0]] : undefined;
			const failure = Array.isArray(configured)
				? configured.shift()
				: configured;
			if (failure !== undefined) {
				return { ok: false, exitCode: 1, stdout: "", stderr: failure };
			}
			const stdout = args[0] === "ls" ? JSON.stringify(lsRecords) : "";
			return { ok: true, exitCode: 0, stdout, stderr: "" };
		},
		async runAsync(args) {
			return cli.run(args);
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
	it("creates named volumes before running the service", async () => {
		const cli = recordingCli();
		await appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		const volumeCreate = cli.calls.findIndex(
			(call) => call[0] === "volume" && call[1] === "create",
		);
		const run = cli.calls.findIndex((call) => call[0] === "run");
		expect(volumeCreate).toBeGreaterThanOrEqual(0);
		expect(run).toBeGreaterThan(volumeCreate);
		expect(cli.calls[volumeCreate]).toEqual([
			"volume",
			"create",
			"-s",
			"256G",
			"gey-main-postgres_data",
		]);
	});

	it("reads the inventory once no matter how many services start", async () => {
		const cli = recordingCli();
		await appleUp(
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

	it("leaves a running container with a matching config hash alone", async () => {
		const plan = buildAppleRunPlan({
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			root: "/repo",
		});
		const hash = plan.services[0]?.configHash ?? "";
		const cli = recordingCli([
			record("gey-main-postgres", "running", { [CONFIG_HASH_LABEL]: hash }),
		]);

		await appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		expect(subcommands(cli)).not.toContain("run --detach");
		expect(subcommands(cli)).not.toContain("delete --force");
	});

	it("starts a stopped container instead of recreating it", async () => {
		const plan = buildAppleRunPlan({
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			root: "/repo",
		});
		const hash = plan.services[0]?.configHash ?? "";
		const cli = recordingCli([
			record("gey-main-postgres", "stopped", { [CONFIG_HASH_LABEL]: hash }),
		]);

		await appleUp(
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

	it("recreates a container whose config hash drifted", async () => {
		const cli = recordingCli([
			record("gey-main-postgres", "running", {
				[CONFIG_HASH_LABEL]: "stale-hash",
			}),
		]);

		await appleUp(
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

describe("appleUp recreating and running", () => {
	it("stops a running container before deleting it for a config change", async () => {
		const cli = recordingCli([
			record("gey-main-postgres", "running", {
				[CONFIG_HASH_LABEL]: "stale-hash",
			}),
		]);

		await appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		expect(
			subcommands(cli).filter((call) => !call.startsWith("volume")),
		).toEqual([
			"ls --all",
			"stop gey-main-postgres",
			"delete --force",
			"run --detach",
		]);
	});

	it("does not stop a container that is already stopped", async () => {
		const cli = recordingCli([
			record("gey-main-postgres", "stopped", {
				[CONFIG_HASH_LABEL]: "stale-hash",
			}),
		]);

		await appleUp(
			cli,
			upRequest(modelFor({ postgres: { port: 5432 } }), ["postgres"]),
		);

		expect(cli.calls.some((call) => call[0] === "stop")).toBe(false);
	});

	it("runs again once when Apple reports the new container missing", async () => {
		const cli = recordingCli([], {
			run: ["Error: container with ID gey-main-redis not found"],
		});

		await appleUp(
			cli,
			upRequest(modelFor({ redis: { port: 6379 } }), ["redis"]),
		);

		expect(cli.calls.filter((call) => call[0] === "run")).toHaveLength(2);
	});

	it("does not retry any other run failure", async () => {
		const cli = recordingCli([], { run: ["Error: image not found: nope"] });

		await expect(
			appleUp(cli, upRequest(modelFor({ redis: { port: 6379 } }), ["redis"])),
		).rejects.toThrow(/image not found/);
		expect(cli.calls.filter((call) => call[0] === "run")).toHaveLength(1);
	});

	it("names whoever holds a published port", async () => {
		const holder = Bun.listen({
			hostname: "0.0.0.0",
			port: 0,
			socket: { data() {} },
		});
		try {
			const cli = recordingCli([], {
				run: `Error: failed to bootstrap container (cause: "bind(descriptor:ptr:bytes:): Address already in use) (errno: 48)")`,
			});

			await expect(
				appleUp(
					cli,
					upRequest(modelFor({ redis: { port: holder.port } }), ["redis"]),
				),
			).rejects.toThrow(
				new RegExp(`port ${holder.port} held by process ${process.pid}`),
			);
		} finally {
			holder.stop(true);
		}
	});

	it("pulls a missing image for its platform only when verbose", async () => {
		// The inspect fails, the pull after it succeeds.
		const cli = recordingCli([], { image: ["Error: image not found"] });

		await appleUp(cli, {
			...upRequest(modelFor({ redis: { port: 6379 } }), ["redis"]),
			verbose: true,
		});

		const pull = cli.calls.findIndex(
			(call) => call[0] === "image" && call[1] === "pull",
		);
		expect(cli.calls[pull]).toEqual([
			"image",
			"pull",
			"--platform",
			"linux/arm64",
			"redis:7-alpine",
		]);
		expect(pull).toBeLessThan(cli.calls.findIndex((call) => call[0] === "run"));

		const quiet = recordingCli([], { image: "Error: image not found" });
		await appleUp(
			quiet,
			upRequest(modelFor({ redis: { port: 6379 } }), ["redis"]),
		);
		expect(quiet.calls.some((call) => call[0] === "image")).toBe(false);
	});

	it("does not pull an image that is already present", async () => {
		const cli = recordingCli();

		await appleUp(cli, {
			...upRequest(modelFor({ redis: { port: 6379 } }), ["redis"]),
			verbose: true,
		});

		expect(cli.calls).toContainEqual(["image", "inspect", "redis:7-alpine"]);
		expect(cli.calls.some((call) => call[1] === "pull")).toBe(false);
	});
});

describe("appleDown", () => {
	it("stops running containers then deletes every one in the project", async () => {
		const cli = recordingCli([
			record("gey-main-postgres", "running", {
				"buncargo.project": "gey-main",
			}),
			record("gey-main-redis", "stopped", { "buncargo.project": "gey-main" }),
			record("other-postgres", "running", { "buncargo.project": "other" }),
		]);

		await appleDown(cli, {
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

	it("throws rather than reporting success when a stop fails", async () => {
		const cli = recordingCli(
			[
				record("gey-main-postgres", "running", {
					"buncargo.project": "gey-main",
				}),
			],
			{ stop: "internal error" },
		);

		await expect(
			appleDown(cli, {
				root: "/repo",
				projectName: "gey-main",
				verbose: false,
			}),
		).rejects.toThrow(/stop containers gey-main-postgres failed/);
	});

	it("tolerates a container that vanished between listing and deleting", async () => {
		const cli = recordingCli(
			[
				record("gey-main-postgres", "stopped", {
					"buncargo.project": "gey-main",
				}),
			],
			{ delete: "Error: no such container" },
		);

		await expect(
			appleDown(cli, {
				root: "/repo",
				projectName: "gey-main",
				verbose: false,
			}),
		).resolves.toBeUndefined();
	});

	it("needs no model to tear a project down", async () => {
		const cli = recordingCli([
			record("gey-main-redis", "running", { "buncargo.project": "gey-main" }),
		]);

		// The detached watchdog runner has no config in scope.
		await appleDown(cli, {
			root: "/repo",
			projectName: "gey-main",
			verbose: false,
		});

		expect(cli.calls).toContainEqual(["delete", "--force", "gey-main-redis"]);
	});

	it("refuses to remove volumes without a model to name them", async () => {
		await expect(
			appleDown(recordingCli(), {
				root: "/repo",
				projectName: "gey-main",
				removeVolumes: true,
				verbose: false,
			}),
		).rejects.toThrow(/without the compose model/);
	});

	it("removes the project's named volumes only with removeVolumes", async () => {
		const withReset = recordingCli();
		await appleDown(withReset, {
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
		await appleDown(withoutReset, {
			root: "/repo",
			projectName: "gey-main",
			model: modelFor({ postgres: { port: 5432 } }),
			verbose: false,
		});
		expect(withoutReset.calls.some((call) => call[0] === "volume")).toBe(false);
	});
});
