import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
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
	writeFileSync(
		join(consumer, "consumer.ts"),
		`
import { defineDevConfig, createDevEnvironment, service } from "buncargo";
${specifiers.map((name, i) => `import * as exported${i} from ${JSON.stringify(name)}; void exported${i};`).join("\n")}
const config = defineDevConfig({ projectPrefix: "fixture", services: { db: service.postgres() }, apps: { web: { port: 3000, devCommand: false } } });
const env = createDevEnvironment(config, { root: process.cwd(), readOnly: true });
const web: number = env.ports.web;
// @ts-expect-error - published declarations must preserve configured keys
void env.ports.missing;
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
	assert(
		command([process.execPath, cli, "--help"], consumer).includes("buncargo"),
	);
	assert(
		command([process.execPath, cli, "--version"], consumer).includes(
			packageJson.version,
		),
	);
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
	const detachedDaemon = join(consumer, "detached", "hostsd.js");
	mkdirSync(dirname(detachedDaemon));
	copyFileSync(join(installed, "dist/hostsd.js"), detachedDaemon);
	const bundle = await Bun.build({
		entrypoints: [detachedDaemon],
		target: "bun",
	});
	assert(
		bundle.success,
		`Standalone daemon does not bundle: ${bundle.logs.join("\n")}`,
	);
	writeFileSync(join(artifacts, "verified-package.txt"), `${packed}\n`);
	console.log(
		`Verified ${packageJson.name}@${packageJson.version}: ${specifiers.length} exports, declarations, CLI, watchdog and standalone daemon.\n${packed}`,
	);
} finally {
	rmSync(consumer, { recursive: true, force: true });
}
