import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isProcessAlive } from "../core/process/lifecycle";
import { CI_ENV_VARS } from "../core/runtime-flags";
import { freePorts, useTempHome } from "../core/test-env.testing";
import { createDevEnvironment } from "./create-dev-environment";
import { SeedFailedError } from "./seed-startup";

useTempHome();

const CLI_BIN = resolve(import.meta.dir, "../cli/bin.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) {
		await fn();
	}
});

/**
 * Write a mock emulator server that prints `EMULATOR_READY` once listening,
 * accepts POST /seed to record seeded state, serves GET /state, and traps
 * SIGTERM to write an export marker before exiting (modeling Firebase's
 * `--export-on-exit` + `stopGraceMs`).
 */
function writeEmulatorScript(dir: string, exportMarker: string): string {
	const path = join(dir, "emulator.ts");
	writeFileSync(
		path,
		`import { writeFileSync } from "node:fs";
const port = Number(process.env.PORT);
let seeded = false;
const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/seed" && req.method === "POST") {
			seeded = true;
			return new Response("seeded");
		}
		if (url.pathname === "/state") {
			return new Response(seeded ? "seeded" : "empty");
		}
		return new Response("ok");
	},
});
console.log("EMULATOR_READY");
const onTerm = () => {
	writeFileSync(${JSON.stringify(exportMarker)}, seeded ? "exported-seeded" : "exported-empty");
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", onTerm);
process.on("SIGINT", onTerm);
`,
	);
	return path;
}

/** Write a mock dependent app that queries the emulator's /state on startup. */
function writeAppScript(dir: string, bootFile: string): string {
	const path = join(dir, "app.ts");
	writeFileSync(
		path,
		`import { writeFileSync } from "node:fs";
const port = Number(process.env.PORT);
const emuUrl = process.env.EMULATOR_URL;
const state = await (await fetch(emuUrl + "/state")).text();
writeFileSync(${JSON.stringify(bootFile)}, state);
Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch() {
		return new Response(state);
	},
});
`,
	);
	return path;
}

/** Write a seeder script that POSTs /seed to the emulator and logs an event. */
function writeSeedScript(
	dir: string,
	options: { fail?: boolean; gateFile?: string; startedFile?: string } = {},
): string {
	const path = join(dir, "seed.ts");
	writeFileSync(
		path,
		`import { existsSync, writeFileSync } from "node:fs";
const emuUrl = process.env.EMULATOR_URL;
if (${JSON.stringify(options.startedFile ?? "")}) {
	writeFileSync(${JSON.stringify(options.startedFile ?? "")}, "started");
}
if (${JSON.stringify(options.gateFile ?? "")}) {
	const deadline = Date.now() + 10_000;
	while (!existsSync(${JSON.stringify(options.gateFile ?? "")}) && Date.now() < deadline) {
		await Bun.sleep(10);
	}
}
if (${JSON.stringify(Boolean(options.fail))}) {
	console.error("plantr: intentional failure");
	process.exit(2);
}
const res = await fetch(emuUrl + "/seed", { method: "POST" });
if (!res.ok) throw new Error("emulator not reachable: " + res.status);
console.log("plantr: seeded");
`,
	);
	return path;
}

function makeDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	writeFileSync(join(dir, "package.json"), "{}");
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("post-app seeding (seed.afterApps)", () => {
	it("waits for prerequisite apps, runs seed.check + seed.command, then starts dependent apps", async () => {
		const dir = makeDir("buncargo-post-seed-block-");
		const [emuPort, appPort] = freePorts(2);
		const exportMarker = join(dir, "exported.txt");
		const bootFile = join(dir, "app-boot.txt");
		writeEmulatorScript(dir, exportMarker);
		writeAppScript(dir, bootFile);
		writeSeedScript(dir);

		let checkSawEmulator = false;
		const env = createDevEnvironment(
			{
				projectPrefix: "postseed",
				services: {},
				apps: {
					emulator: {
						port: emuPort,
						devCommand: "bun emulator.ts",
						readyWhen: /EMULATOR_READY/,
						stopGraceMs: 5_000,
					},
					app: {
						port: appPort,
						devCommand: "bun app.ts",
						healthEndpoint: "/",
					},
				},
				seed: {
					afterApps: ["emulator"],
					command: "bun seed.ts",
					check: async ({ urls }) => {
						const state = await (await fetch(`${urls.emulator}/state`)).text();
						checkSawEmulator = state === "empty";
						return state === "empty";
					},
				},
				options: { hosts: false, worktreeIsolation: false, verbose: false },
			},
			{ root: dir },
		);
		cleanups.push(() => env.stop());

		const savedOffset = process.env.BUNCARGO_PORT_OFFSET;
		process.env.BUNCARGO_PORT_OFFSET = "0";
		cleanups.push(() => {
			if (savedOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
			else process.env.BUNCARGO_PORT_OFFSET = savedOffset;
		});

		const pids = await env.start({ watchdog: false, productionBuild: false });
		expect(pids?.emulator).toBeGreaterThan(0);
		expect(pids?.app).toBeGreaterThan(0);
		expect(checkSawEmulator).toBe(true);
		// Dependent app saw the seeded state immediately on boot!
		expect(readFileSync(bootFile, "utf8")).toBe("seeded");
		expect(await (await fetch(env.urls.app)).text()).toBe("seeded");
	}, 20_000);

	it("overlaps remaining apps when seed.beforeApps is false while still waiting for afterApps first", async () => {
		const dir = makeDir("buncargo-post-seed-overlap-");
		const [emuPort, appPort] = freePorts(2);
		const exportMarker = join(dir, "exported.txt");
		const bootFile = join(dir, "app-boot.txt");
		const gateFile = join(dir, "release-seed.txt");
		const startedFile = join(dir, "seed-started.txt");
		writeEmulatorScript(dir, exportMarker);
		writeAppScript(dir, bootFile);
		writeSeedScript(dir, { gateFile, startedFile });

		const savedOffset = process.env.BUNCARGO_PORT_OFFSET;
		process.env.BUNCARGO_PORT_OFFSET = "0";
		cleanups.push(() => {
			if (savedOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
			else process.env.BUNCARGO_PORT_OFFSET = savedOffset;
		});

		const env = createDevEnvironment(
			{
				projectPrefix: "postoverlap",
				services: {},
				apps: {
					emulator: {
						port: emuPort,
						devCommand: "bun emulator.ts",
						readyWhen: /EMULATOR_READY/,
					},
					app: {
						port: appPort,
						devCommand: "bun app.ts",
						// Starts after emulator is up, but does NOT wait for the gated seed!
						startAfter: ["emulator"],
						healthEndpoint: "/",
					},
				},
				seed: {
					afterApps: ["emulator"],
					beforeApps: false,
					command: "bun seed.ts",
				},
				options: { hosts: false, worktreeIsolation: false, verbose: false },
			},
			{ root: dir },
		);
		cleanups.push(() => env.stop());

		const starting = env.start({ watchdog: false, productionBuild: false });
		// Wait until BOTH the seed started (after emulator ready) AND `app` booted
		// while the seed is still gated, proving overlap.
		const deadline = Date.now() + 10_000;
		while (
			(!existsSync(startedFile) || !existsSync(bootFile)) &&
			Date.now() < deadline
		) {
			await Bun.sleep(20);
		}
		expect(existsSync(startedFile)).toBe(true);
		expect(existsSync(bootFile)).toBe(true);
		// `app` booted before the seed finished.
		expect(readFileSync(bootFile, "utf8")).toBe("empty");

		// Now release the seed gate; `env.start()` waits for the seed to finish.
		writeFileSync(gateFile, "go");
		await starting;
		expect(await (await fetch(`${env.urls.emulator}/state`)).text()).toBe(
			"seeded",
		);
	}, 20_000);

	it("stops prerequisite apps cleanly when the post-app seed fails", async () => {
		const dir = makeDir("buncargo-post-seed-fail-");
		const [emuPort, appPort] = freePorts(2);
		const exportMarker = join(dir, "exported.txt");
		const bootFile = join(dir, "app-boot.txt");
		writeEmulatorScript(dir, exportMarker);
		writeAppScript(dir, bootFile);
		writeSeedScript(dir, { fail: true });

		const savedOffset = process.env.BUNCARGO_PORT_OFFSET;
		process.env.BUNCARGO_PORT_OFFSET = "0";
		cleanups.push(() => {
			if (savedOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
			else process.env.BUNCARGO_PORT_OFFSET = savedOffset;
		});

		const env = createDevEnvironment(
			{
				projectPrefix: "postfail",
				services: {},
				apps: {
					emulator: {
						port: emuPort,
						devCommand: "bun emulator.ts",
						readyWhen: /EMULATOR_READY/,
						stopGraceMs: 5_000,
					},
					app: {
						port: appPort,
						devCommand: "bun app.ts",
						healthEndpoint: "/",
					},
				},
				seed: {
					afterApps: ["emulator"],
					command: "bun seed.ts",
				},
				options: { hosts: false, worktreeIsolation: false, verbose: false },
			},
			{ root: dir },
		);
		cleanups.push(() => env.stop());

		const caught = await env
			.start({ watchdog: false, productionBuild: false })
			.catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(SeedFailedError);
		// Dependent app never spawned; emulator was stopped cleanly via SIGTERM.
		expect(existsSync(bootFile)).toBe(false);
		expect(readFileSync(exportMarker, "utf8")).toBe("exported-empty");
	}, 20_000);

	it("runs `buncargo dev --seed` by starting prerequisite apps, seeding, and tearing them down gracefully", async () => {
		const dir = makeDir("buncargo-cli-seed-after-");
		const [emuPort, webPort] = freePorts(2);
		const exportMarker = join(dir, "exported.txt");
		const webBootFile = join(dir, "web-boot.txt");
		writeEmulatorScript(dir, exportMarker);
		writeAppScript(dir, webBootFile);
		writeSeedScript(dir);

		writeFileSync(
			join(dir, "dev.config.ts"),
			`export default {
				projectPrefix: "cliseed",
				services: {},
				apps: {
					emulator: {
						port: ${emuPort},
						devCommand: "bun emulator.ts",
						readyWhen: /EMULATOR_READY/,
						stopGraceMs: 5000,
					},
					web: {
						port: ${webPort},
						devCommand: "bun app.ts",
						healthEndpoint: "/",
					},
				},
				seed: {
					afterApps: ["emulator"],
					command: "bun seed.ts",
					// Ignored by --seed (forced).
					check: async () => false,
				},
				options: { hosts: false, worktreeIsolation: false },
			};`,
		);

		const childEnv: Record<string, string | undefined> = {
			...process.env,
			HOME: join(dir, "home"),
			BUNCARGO_PORT_OFFSET: "0",
		};
		for (const name of [...CI_ENV_VARS, "BUNCARGO_HOSTS"])
			delete childEnv[name];

		const proc = Bun.spawn([process.execPath, CLI_BIN, "dev", "--seed"], {
			cwd: dir,
			env: childEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
		expect(Bun.stripANSI(stdout)).toContain("Seeding complete");
		// Non-prerequisite app must NOT have been started by `dev --seed`.
		expect(existsSync(webBootFile)).toBe(false);
		// Emulator ran, received seeded state, and exited cleanly via SIGTERM (exporting data!).
		expect(readFileSync(exportMarker, "utf8")).toBe("exported-seeded");
	}, 20_000);

	it("reuses an already-running prerequisite app in `buncargo dev --seed` without stopping it", async () => {
		const dir = makeDir("buncargo-cli-seed-reuse-");
		const [emuPort, webPort] = freePorts(2);
		const exportMarker = join(dir, "exported.txt");
		const webBootFile = join(dir, "web-boot.txt");
		const emuPath = writeEmulatorScript(dir, exportMarker);
		writeAppScript(dir, webBootFile);
		writeSeedScript(dir);

		writeFileSync(
			join(dir, "dev.config.ts"),
			`export default {
				projectPrefix: "cliseedreuse",
				services: {},
				apps: {
					emulator: {
						port: ${emuPort},
						devCommand: "bun emulator.ts",
						readyWhen: /EMULATOR_READY/,
					},
					web: {
						port: ${webPort},
						devCommand: "bun app.ts",
						healthEndpoint: "/",
					},
				},
				seed: {
					afterApps: ["emulator"],
					command: "bun seed.ts",
				},
				options: { hosts: false, worktreeIsolation: false },
			};`,
		);

		// Start the emulator independently first (simulating an already-running `buncargo dev`).
		const preExisting = Bun.spawn([process.execPath, emuPath], {
			cwd: dir,
			env: { ...process.env, PORT: String(emuPort) },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		cleanups.push(async () => {
			if (isProcessAlive(preExisting.pid)) {
				preExisting.kill("SIGKILL");
				await preExisting.exited;
			}
		});

		// Wait until the pre-existing emulator answers HTTP.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`http://127.0.0.1:${emuPort}/state`);
				if (res.ok) break;
			} catch {
				// Not listening yet.
			}
			await Bun.sleep(20);
		}

		const childEnv: Record<string, string | undefined> = {
			...process.env,
			HOME: join(dir, "home"),
			BUNCARGO_PORT_OFFSET: "0",
		};
		for (const name of [...CI_ENV_VARS, "BUNCARGO_HOSTS"])
			delete childEnv[name];

		const proc = Bun.spawn([process.execPath, CLI_BIN, "dev", "--seed"], {
			cwd: dir,
			env: childEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
		expect(Bun.stripANSI(stdout)).toContain("Seeding complete");
		// Pre-existing emulator was seeded AND kept running!
		expect(isProcessAlive(preExisting.pid)).toBe(true);
		expect(existsSync(exportMarker)).toBe(false);
		expect(
			await (await fetch(`http://127.0.0.1:${emuPort}/state`)).text(),
		).toBe("seeded");
	}, 20_000);
});
