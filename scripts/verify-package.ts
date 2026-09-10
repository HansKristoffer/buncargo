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
	// Node selects the published import condition, Bun selects the source condition.
	command(["node", "imports.mjs"], consumer);
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
import { defineDevConfig, createDevEnvironment, service } from "buncargo";
${specifiers.map((name, i) => `import * as exported${i} from ${JSON.stringify(name)}; void exported${i};`).join("\n")}
const config = defineDevConfig({
  projectPrefix: "fixture",
  services: { db: service.postgres() },
  apps: { web: { port: 3000, devCommand: false } },
});

const env = createDevEnvironment(config, { root: process.cwd(), readOnly: true });
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
const mixedEnv = createDevEnvironment(mixed, {
  root: process.cwd(),
  readOnly: true,
});

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
import { realpathSync } from "node:fs";
import { installConnectBundle } from "./node_modules/buncargo/src/core/connect/bundle.ts";
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
	const watchdog = join(installed, "dist/core/watchdog-runner.js");
	const watchdogResult = Bun.spawnSync([process.execPath, watchdog], {
		cwd: consumer,
		env: { PATH: process.env.PATH ?? "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(watchdogResult.exitCode, 1);
	assert(
		watchdogResult.stderr
			.toString()
			.includes("Missing required environment variables"),
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
