import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Every module of the installed package in `modules` is one of its built files. */
function assertOneBuild(modules: readonly string[], installed: string) {
	const own = modules.filter((path) => path.startsWith(`${installed}/`));
	assert(own.length > 0, "no module of the installed package loaded");
	const foreign = own.filter((path) => !path.startsWith(`${installed}/dist/`));
	assert.deepEqual(foreign, [], "modules outside the installed build");
}

/**
 * A config with an integration, loaded by the packed CLI: the config's
 * `buncargo` and `buncargo/firebase` are the CLI's own modules, the CLI
 * recognizes the apps the config's `discoverApps` made, and none of the
 * commands it spawns, the integration's CLI among them, sees a variable in
 * `unsetEnv`.
 */
function verifyConfigWithIntegration(
	consumer: string,
	cli: string,
	installed: string,
) {
	const modulesFile = join(consumer, "loaded-modules.json");
	writeFileSync(
		join(consumer, "dev.config.ts"),
		`import { writeFileSync } from "node:fs";
import { defineDevConfig, discoverApps } from "buncargo";
import { firebase } from "buncargo/firebase";

if (process.env.VERIFY_MODULES_FILE)
  writeFileSync(process.env.VERIFY_MODULES_FILE, JSON.stringify(Object.keys(require.cache)));

export default defineDevConfig({
  projectPrefix: "graph-fixture",
  services: {},
  apps: discoverApps({ globs: ["tools/*"] }),
  unsetEnv: ["VERIFY_UNSET"],
  integrations: [firebase({ persist: false })],
});`,
	);
	writeFileSync(
		join(consumer, "firebase.json"),
		JSON.stringify({ emulators: { auth: { port: 9099 } } }),
	);
	// The integration resolves the checkout's own `node_modules/.bin` first.
	const reportEnv = `#!/bin/sh\nprintf '%s|%s' "\${VERIFY_UNSET-unset}" "$VERIFY_KEPT"\n`;
	const fakeFirebase = join(consumer, "node_modules", ".bin", "firebase");
	writeFileSync(fakeFirebase, reportEnv, { mode: 0o755 });
	const tool = join(consumer, "tools", "probe");
	mkdirSync(tool, { recursive: true });
	writeFileSync(join(tool, "report-env.sh"), reportEnv, { mode: 0o755 });
	writeFileSync(
		join(tool, "package.json"),
		JSON.stringify({
			scripts: { dev: "sh report-env.sh", build: "sh report-env.sh" },
		}),
	);
	const env = {
		...process.env,
		VERIFY_UNSET: "set",
		VERIFY_KEPT: "kept",
		VERIFY_MODULES_FILE: modulesFile,
	};

	const built = command(
		[process.execPath, cli, "build", "--discovered"],
		consumer,
		env,
	);
	assert(built.includes("unset|kept"), built);
	assertOneBuild(JSON.parse(readFileSync(modulesFile, "utf8")), installed);

	writeFileSync(
		join(consumer, "integration-cli.ts"),
		`import { loadDevEnv } from "buncargo/api";
const env = await loadDevEnv();
const app = env.apps.firebase;
if (!app || !("devCommand" in app)) throw new Error("no firebase app");
const { stdout } = await env.exec(app.devCommand, { app: "firebase" });
process.stdout.write(stdout);`,
	);
	const { VERIFY_MODULES_FILE: _file, ...libraryEnv } = env;
	assert.equal(
		command([process.execPath, "integration-cli.ts"], consumer, libraryEnv),
		"unset|kept",
	);
}
const artifacts = join(root, ".buncargo", "artifacts");
mkdirSync(artifacts, { recursive: true });
function command(argv: string[], cwd: string, env = process.env) {
	const result = Bun.spawnSync(argv, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(
		result.exitCode,
		0,
		`${argv.join(" ")}\n${result.stdout.toString()}\n${result.stderr.toString()}`,
	);
	return result.stdout.toString();
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packed = process.argv[2]
	? resolve(process.argv[2])
	: join(
			artifacts,
			JSON.parse(
				command(
					[
						"npm",
						"pack",
						"--ignore-scripts",
						"--json",
						"--pack-destination",
						artifacts,
					],
					root,
				),
			)[0].filename,
		);
const consumer = mkdtempSync(join(tmpdir(), "buncargo-consumer $ space-"));
try {
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({ private: true, type: "module" }),
	);
	command(
		[
			"npm",
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			packed,
			`typescript@${manifest.devDependencies.typescript}`,
			`@types/bun@${manifest.devDependencies["@types/bun"]}`,
		],
		consumer,
	);
	const installed = join(consumer, "node_modules", "buncargo");
	const packageJson = JSON.parse(
		readFileSync(join(installed, "package.json"), "utf8"),
	);
	const specifiers: string[] = [];
	for (const [subpath, conditions] of Object.entries(packageJson.exports) as [
		string,
		Record<string, string>,
	][]) {
		specifiers.push(
			subpath === "." ? "buncargo" : `buncargo/${subpath.slice(2)}`,
		);
		for (const target of Object.values(conditions))
			assert(
				existsSync(join(installed, target)),
				`${subpath} missing ${target}`,
			);
	}
	writeFileSync(
		join(consumer, "imports.mjs"),
		`for (const name of ${JSON.stringify(specifiers)}) await import(name);`,
	);
	command([process.execPath, "imports.mjs"], consumer);
	command(["node", "imports.mjs"], consumer);
	// Bun loads the same build the CLI runs: a second copy of a module keeps
	// its own module state. The package ships no source to load.
	assert(!existsSync(join(installed, "src")), "the package ships src/");
	const rootModules: string[] = JSON.parse(
		command(
			[
				process.execPath,
				"-e",
				'await import("buncargo"); console.log(JSON.stringify(Object.keys(require.cache)))',
			],
			consumer,
		),
	);
	assertOneBuild(rootModules, installed);
	assert(
		rootModules.length <= 60,
		`import "buncargo" loads ${rootModules.length} modules`,
	);
	// Exercise the published browser entry, including shared build chunks.
	const clientBuild = await Bun.build({
		entrypoints: [join(installed, packageJson.exports["./client"].browser)],
		target: "browser",
		format: "cjs",
	});
	assert(clientBuild.success, clientBuild.logs.join("\n"));
	const clientOutput = clientBuild.outputs[0];
	assert(clientOutput, "Missing client helper bundle");
	const clientPrefix = new Function(
		"module",
		"__DEV__",
		"process",
		`${await clientOutput.text()}\nreturn module.exports.devCookiePrefix("platform", "0123456789abcdef");`,
	);
	assert.equal(
		clientPrefix({ exports: {} }, true, undefined),
		"platform-0123456789abcdef",
	);
	assert.equal(clientPrefix({ exports: {} }, false, undefined), "platform");
	assert.equal(
		clientPrefix({ exports: {} }, undefined, {
			env: { NODE_ENV: "production" },
		}),
		"platform",
	);
	writeFileSync(
		join(consumer, "consumer.ts"),
		`
import { defineDevConfig, service } from "buncargo";
import { createDevEnvironment } from "buncargo/api";
${specifiers.map((name, i) => `import * as exported${i} from ${JSON.stringify(name)}; void exported${i};`).join("\n")}
const config = defineDevConfig({
  projectPrefix: "fixture",
  services: { db: service.postgres() },
  apps: { web: { port: 3000, devCommand: false } },
});

const env = createDevEnvironment(config, { root: process.cwd() });
const web: number = env.ports.web;
// @ts-expect-error - published declarations must preserve configured keys
void env.ports.missing;

const legacyPort: number = service.postgres().port;
const mixed = defineDevConfig({
  projectPrefix: "mixed",
  services: {
    init: { kind: "job", rerun: "always", docker: { image: "postgres:16" } },
  },
  apps: { jobs: { kind: "worker", devCommand: "bun run jobs.ts" } },
});
const mixedEnv = createDevEnvironment(mixed, { root: process.cwd() });

// @ts-expect-error - workers have no port
void mixedEnv.ports.jobs;
// @ts-expect-error - jobs have no host URL
void mixedEnv.urls.init;
// @ts-expect-error - workers cannot expose HTTP endpoints
const invalidWorker: import("buncargo").AppConfig = { kind: "worker", devCommand: "run", port: 3000 };
// @ts-expect-error - rerun policy is an explicit consumer decision
const invalidJob: import("buncargo").ServiceConfig = { kind: "job", docker: { image: "postgres:16" } };

void legacyPort;
void invalidWorker;
void invalidJob;
void web;
`,
	);
	writeFileSync(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				noEmit: true,
				strict: true,
				skipLibCheck: true,
				module: "preserve",
				moduleResolution: "bundler",
				target: "esnext",
				types: ["bun"],
			},
			files: ["consumer.ts"],
		}),
	);
	command(
		[
			process.execPath,
			join(consumer, "node_modules/typescript/bin/tsc"),
			"-p",
			"tsconfig.json",
		],
		consumer,
	);
	const cli = join(installed, packageJson.bin.buncargo);
	writeFileSync(
		join(consumer, "dev.config.ts"),
		`export default {
  projectPrefix: "exec-fixture",
  services: {},
  apps: {
    jobs: {
      kind: "worker",
      devCommand: "unused",
      staticEnv: { APP_VALUE: "ok" },
    },
  },
};`,
	);
	const argv = ["a b", "a'b", 'a"b', "$HOME", "$(false)", ";", "--app=child"];
	assert.deepEqual(
		JSON.parse(
			command(
				[
					process.execPath,
					cli,
					"exec",
					"--app=jobs",
					"--",
					process.execPath,
					"-e",
					"process.stdout.write(JSON.stringify({args:process.argv.slice(1),overlay:process.env.APP_VALUE,port:process.env.PORT}))",
					...argv,
				],
				consumer,
			),
		),
		{ args: argv, overlay: "ok" },
	);
	verifyConfigWithIntegration(consumer, cli, installed);

	assert(
		command([process.execPath, cli, "--help"], consumer).includes("buncargo"),
	);
	assert(
		command([process.execPath, cli, "--version"], consumer).includes(
			packageJson.version,
		),
	);
	assert(
		command([process.execPath, cli, "connect", "--help"], consumer).includes(
			"BUNCARGO_CONNECT_TOKENS",
		),
	);
	// Bun canonicalizes argv[1]; symlinked homes must identify the same coordinator bundle.
	const realHome = join(consumer, "home");
	const linkedHome = join(consumer, "linked-home");
	mkdirSync(realHome);
	symlinkSync(realHome, linkedHome, "dir");
	const bundleProbe = join(consumer, "bundle-probe.ts");
	writeFileSync(
		bundleProbe,
		`
import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
// Not exported: the chunk of the installed build that holds it.
const dist = "./node_modules/buncargo/dist";
const chunk = readdirSync(dist).find((name) =>
	name.endsWith(".js") &&
	/export \\{[^}]*\\binstallConnectBundle\\b/.test(readFileSync(\`\${dist}/\${name}\`, "utf8")),
);
assert(chunk, "no chunk exports installConnectBundle");
const { installConnectBundle } = await import(\`\${dist}/\${chunk}\`);
const path = installConnectBundle();
assert.equal(path, realpathSync(path));
assert.equal(installConnectBundle(), path);
console.log(path);
`,
	);
	const installedPaths = [linkedHome, realHome].map((home) =>
		command([process.execPath, bundleProbe], consumer, { HOME: home }),
	);
	assert.equal(installedPaths[0], installedPaths[1]);
	// The watchdog is machine-wide and configured by nothing but the run
	// registry, so the only thing to prove here is that the packed bundle
	// runs standalone out of the installed package — it is executed by a
	// detached process that cannot reach the consumer's code-split chunks.
	//
	// Hermetic on purpose: an isolated HOME so it reads an empty registry,
	// and a PATH of one empty directory so it finds no container runtime. It
	// therefore has nothing to watch and exits at once, and cannot touch
	// whatever Docker stacks the machine running this happens to have. An
	// empty PATH is no substitute: Bun then falls back to /usr/bin and finds
	// the real `docker`, so DOCKER_HOST points at nothing as well. With the
	// tailnet directory on, a machine with Tailscale would keep it serving.
	const watchdogHome = join(consumer, "watchdog-home");
	const emptyBin = join(consumer, "watchdog-empty-bin");
	mkdirSync(watchdogHome, { recursive: true });
	mkdirSync(emptyBin, { recursive: true });
	const watchdog = join(installed, "dist/core/watchdog-runner.js");
	const watchdogResult = Bun.spawnSync([process.execPath, watchdog], {
		cwd: consumer,
		env: {
			PATH: emptyBin,
			HOME: watchdogHome,
			DOCKER_HOST: "unix:///nonexistent/buncargo-verify-package.sock",
			BUNCARGO_TAILNET_DIRECTORY: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(watchdogResult.exitCode, 0);
	assert(watchdogResult.stdout.toString().includes("Nothing left to watch"));
	// Its version is read from the installed package.json, through the
	// build's chunk layout; `ensureWatchdog` replaces a runner without one.
	assert(
		watchdogResult.stdout
			.toString()
			.includes(`[watchdog ${packageJson.version} pid `),
	);
	for (const daemon of ["hostsd.js", "connectd.js"]) {
		const detachedDaemon = join(consumer, "detached", daemon);
		mkdirSync(dirname(detachedDaemon), { recursive: true });
		copyFileSync(join(installed, "dist", daemon), detachedDaemon);
		if (daemon === "connectd.js")
			assert(
				command(
					[process.execPath, detachedDaemon, "connect", "--help"],
					consumer,
				).includes("BUNCARGO_CONNECT_TOKENS"),
			);
		const bundle = await Bun.build({
			entrypoints: [detachedDaemon],
			target: "bun",
		});
		assert(
			bundle.success,
			`Standalone ${daemon} does not bundle: ${bundle.logs.join("\n")}`,
		);
	}
	writeFileSync(join(artifacts, "verified-package.txt"), `${packed}\n`);
	console.log(
		`Verified ${packageJson.name}@${packageJson.version}: ${specifiers.length} exports, declarations, CLI, watchdog and standalone daemons.\n${packed}`,
	);
} finally {
	rmSync(consumer, { recursive: true, force: true });
}
