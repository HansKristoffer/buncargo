import { describe, expect, it } from "bun:test";
import {
	CONNECT_TOKENS_ENV,
	DETACHED_ENV,
	PORT_OFFSET_ENV,
} from "../core/runtime-flags";
import type { LinkInspection, ResolvedLinkConfig } from "../types";
import {
	buildLinkedStartArgv,
	linkedStartEnv,
	planLinkedStarts,
	startLinkedCheckouts,
} from "./dev-links";
import { CliError } from "./errors";

function makeInspection(
	overrides: Partial<LinkInspection> & { name: string; project: string },
): LinkInspection {
	return {
		status: "not-running",
		required: false,
		source: "none",
		targetRoot: `/code/${overrides.name}`,
		missingApps: [],
		missingServices: [],
		candidates: [],
		...overrides,
	};
}

describe("planLinkedStarts", () => {
	const linksConfig: Record<string, ResolvedLinkConfig> = {
		kanpla: {
			project: "kanpla",
			required: true,
			profile: "local",
		},
		backend: {
			project: "kanpla-backend",
			required: false,
			profile: "minimal",
		},
		alreadyUp: { project: "auth", required: true },
		stalePin: { project: "payments", required: true },
		pathless: { project: "docs", required: false },
	};

	const inspections: LinkInspection[] = [
		makeInspection({ name: "kanpla", project: "kanpla", required: true }),
		makeInspection({
			name: "backend",
			project: "kanpla-backend",
			required: false,
		}),
		makeInspection({
			name: "alreadyUp",
			project: "auth",
			required: true,
			status: "linked",
		}),
		makeInspection({
			name: "stalePin",
			project: "payments",
			required: true,
			pinMissing: true,
		}),
		makeInspection({
			name: "pathless",
			project: "docs",
			required: false,
			targetRoot: undefined,
		}),
	];

	it("plans required missing links for the before phase and optional ones for after", () => {
		expect(planLinkedStarts(inspections, linksConfig, "before")).toEqual([
			{
				name: "kanpla",
				project: "kanpla",
				targetRoot: "/code/kanpla",
				required: true,
				profile: "local",
			},
		]);

		expect(planLinkedStarts(inspections, linksConfig, "after")).toEqual([
			{
				name: "backend",
				project: "kanpla-backend",
				targetRoot: "/code/backend",
				required: false,
				profile: "minimal",
			},
		]);
	});
});

describe("buildLinkedStartArgv and linkedStartEnv", () => {
	it("builds a detached start without --with-links and includes profile when set", () => {
		const cli = { program: "/usr/bin/bun", script: "/pkg/dist/cli/bin.js" };
		expect(buildLinkedStartArgv(cli, {})).toEqual([
			"/usr/bin/bun",
			"/pkg/dist/cli/bin.js",
			"dev",
			"--detach",
		]);
		expect(buildLinkedStartArgv(cli, { profile: "local-fast" })).toEqual([
			"/usr/bin/bun",
			"/pkg/dist/cli/bin.js",
			"dev",
			"--detach",
			"--profile=local-fast",
		]);
	});

	it("strips parent buncargo, port offset, and egress proxy env vars", () => {
		const env = linkedStartEnv({
			PATH: "/usr/bin",
			[DETACHED_ENV]: "idle-limit",
			[PORT_OFFSET_ENV]: "100",
			[CONNECT_TOKENS_ENV]: "tok",
			BUNCARGO_APP_NAME: "web",
			BUNCARGO_APP_HOSTNAME: "web.localhost",
			HTTP_PROXY: "http://127.0.0.1:41234",
			HTTPS_PROXY: "http://127.0.0.1:41234",
			NO_PROXY: "localhost",
			NODE_USE_ENV_PROXY: "1",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env[DETACHED_ENV]).toBeUndefined();
		expect(env[PORT_OFFSET_ENV]).toBeUndefined();
		expect(env[CONNECT_TOKENS_ENV]).toBeUndefined();
		expect(env.BUNCARGO_APP_NAME).toBeUndefined();
		expect(env.BUNCARGO_APP_HOSTNAME).toBeUndefined();
		expect(env.HTTP_PROXY).toBeUndefined();
		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(env.NO_PROXY).toBeUndefined();
		expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
	});
});

describe("startLinkedCheckouts", () => {
	it("throws CliError on required failure and warns without throwing on optional failure", async () => {
		const spawned: { argv: readonly string[]; cwd: string }[] = [];
		await expect(
			startLinkedCheckouts(
				[
					{
						name: "kanpla",
						project: "kanpla",
						targetRoot: "/code/kanpla",
						required: true,
						profile: "local",
					},
				],
				{
					cli: { program: "bun", script: "bin.ts" },
					runSpawn: async (argv, opts) => {
						spawned.push({ argv, cwd: opts.cwd });
						return { exitCode: 1, output: "Firebase CLI missing" };
					},
				},
			),
		).rejects.toThrow(CliError);
		expect(spawned).toEqual([
			{
				argv: ["bun", "bin.ts", "dev", "--detach", "--profile=local"],
				cwd: "/code/kanpla",
			},
		]);

		const warnings: string[] = [];
		const done: string[] = [];
		await startLinkedCheckouts(
			[
				{
					name: "backend",
					project: "kanpla-backend",
					targetRoot: "/code/backend",
					required: false,
				},
				{
					name: "analytics",
					project: "kanpla-analytics",
					targetRoot: "/code/analytics",
					required: false,
				},
			],
			{
				cli: { program: "bun", script: "bin.ts" },
				onWarning: (msg) => warnings.push(msg),
				onDone: (target) => done.push(target.name),
				runSpawn: async (_argv, opts) =>
					opts.cwd === "/code/backend"
						? { exitCode: 1, output: "failed to boot" }
						: { exitCode: 0, output: "ok" },
			},
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('optional linked repo "backend"');
		expect(done).toEqual(["analytics"]);
	});
});
