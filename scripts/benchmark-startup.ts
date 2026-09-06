/** Isolated end-to-end dev benchmark: real CLI/apps, deterministic fake runtime. */
import { spawn, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { terminateOwnedProcess } from "../src/core/process/terminate";

const option = (name: string, fallback: string) =>
	process.argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3) ?? fallback;
const cli = resolve(option("cli", "dist/cli/bin.js"));
const samples = Number(option("samples", "10"));
const parallel = Number(option("parallel", "1"));
const delay = Number(option("app-delay", "120"));
const legacy = process.argv.includes("--legacy");
for (const [name, value] of Object.entries({ samples, parallel, delay }))
	if (!Number.isInteger(value) || value < (name === "delay" ? 0 : 1))
		throw new Error(`Invalid ${name}`);
const root = mkdtempSync(join(tmpdir(), "buncargo startup benchmark "));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No ephemeral port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

interface Result {
	wallMs: number;
	readyResponseMs: number;
	cli?: {
		totalMs: number;
		phases: unknown[];
		counters?: Record<string, number>;
	};
}
async function worker(index: number): Promise<Result[]> {
	const { mkdirSync } = await import("node:fs");
	const project = join(root, `checkout-${index}`);
	mkdirSync(project);
	const port = await unusedPort();
	const servicePort = await unusedPort();
	const fake = join(project, "runtime.ts");
	const binary = join(project, "fake docker");
	const state = join(project, "runtime-state.json");
	const log = join(project, "runtime-calls.jsonl");
	writeFileSync(
		fake,
		`import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('up')) {writeFileSync(${JSON.stringify(state)}, JSON.stringify(process.env)); process.exit(0);}
if(args[0]==='info') {console.log('benchmark'); process.exit(0);}
if(args[0]==='ps' && args.join(' ').includes('buncargo.service') && existsSync(${JSON.stringify(state)})) {
const env=JSON.parse(readFileSync(${JSON.stringify(state)},'utf8')); const hash=Object.entries(env).find(([key])=>key.startsWith('BUNCARGO_SERVICE_HASH_'))?.[1]??'';
console.log(['postgres','running',env.BUNCARGO_STACK_HASH??'','Up (healthy)',hash].join('\\t'));}
`,
	);
	writeFileSync(
		binary,
		`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`,
	);
	chmodSync(binary, 0o700);
	// Older CLIs bypassed the selected adapter in app-port lookups. Keep those probes isolated too.
	writeFileSync(join(project, "docker"), readFileSync(binary), { mode: 0o700 });
	writeFileSync(join(project, "container"), "#!/bin/sh\nexit 1\n", {
		mode: 0o700,
	});
	const app = join(project, "app.ts");
	writeFileSync(
		app,
		`const began=performance.now(); Bun.serve({port:Number(process.env.PORT), hostname:'127.0.0.1', fetch(){return new Response('ready',{status:performance.now()-began>=${delay}?200:503});}});`,
	);
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: `benchmark-${index}`, private: true }),
	);
	writeFileSync(
		join(project, "dev.config.ts"),
		`export default ${JSON.stringify({ projectPrefix: `bench-${index}`, services: { postgres: { port: servicePort, healthCheck: false } }, apps: { web: { port, devCommand: `${quote(process.execPath)} ${quote(app)}`, requiredServices: ["postgres"], healthEndpoint: "/ready" } }, docker: { runtime: "docker", binary }, options: { hosts: false, autoShutdown: false, verbose: false, worktreeIsolation: false } })};`,
	);
	const readyFile = join(project, "cli-ready");
	const runner = join(project, "runner.ts");
	const packageRoot = resolve(cli, "../../..");
	writeFileSync(
		runner,
		`import {loadDevEnv} from ${JSON.stringify(join(packageRoot, "dist/loader/index.js"))}; import {runCli} from ${JSON.stringify(join(packageRoot, "dist/cli/index.js"))}; import {writeFileSync} from 'node:fs'; const env=await loadDevEnv(); const wait=env.waitForServers.bind(env); env.waitForServers=async options=>{await wait(options); writeFileSync(${JSON.stringify(readyFile)}, String(performance.now()));}; await runCli(env,{args:process.argv.slice(2)});`,
	);
	const results: Result[] = [];
	// The first iteration warms the generated file/runtime and is reported separately.
	for (let sample = 0; sample <= samples; sample++) {
		let output = "";
		let report: Result["cli"];
		const ownedAppPids = new Set<number>();
		let readyResponseMs: number | undefined;
		rmSync(readyFile, { force: true });
		const began = performance.now();
		const child = spawn(
			process.execPath,
			[
				legacy ? runner : cli,
				...(legacy ? [] : ["dev"]),
				"--no-hosts",
				"--keep-containers",
				legacy ? "--timing" : "--timing-json",
			],
			{
				cwd: project,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					HOME: root,
					PATH: `${project}${delimiter}${process.env.PATH ?? ""}`,
					BUNCARGO_PORT_OFFSET: "0",
					CI: "false",
					GITHUB_ACTIONS: "false",
				},
			},
		);
		children.add(child);
		child.on("error", (error) => {
			output += String(error);
		});
		child.stdout!.on("data", (data) => {
			output += data;
			for (const match of String(data).matchAll(/PID:\s*(\d+)/g))
				ownedAppPids.add(Number(match[1]));
			for (const line of String(data).split("\n")) {
				try {
					const value = JSON.parse(line);
					if (value.type === "buncargo.startup") report = value;
				} catch {
					/* Rich CLI output. */
				}
			}
		});
		child.stderr!.on("data", (data) => {
			output += data;
		});
		try {
			while (performance.now() - began < 30000) {
				if (child.exitCode !== null)
					throw new Error(`CLI exited ${child.exitCode}: ${output}`);
				try {
					const response = await fetch(`http://127.0.0.1:${port}/ready`, {
						signal: AbortSignal.timeout(100),
					});
					await response.text();
					if (response.ok && readyResponseMs === undefined)
						readyResponseMs = performance.now() - began;
				} catch {
					/* Still starting. */
				}
				// Legacy timing stopped before app spawn; detect its health completion via the first successful response.
				if (legacy) {
					try {
						const marked = Number(readFileSync(readyFile, "utf8"));
						if (marked) report = { totalMs: marked, phases: [] };
					} catch {
						/* Still waiting for the CLI probe. */
					}
				}
				if (readyResponseMs !== undefined && report) break;
				await sleep(10);
			}
			if (readyResponseMs === undefined || !report)
				throw new Error(`Startup timed out: ${output}`);
			const result = {
				wallMs: performance.now() - began,
				readyResponseMs,
				cli: report,
			};
			if (sample === 0)
				console.error(
					JSON.stringify({
						worker: index,
						scenario: "cold fixture",
						...result,
					}),
				);
			else results.push(result);
		} finally {
			await terminateOwnedProcess(child, 5000);
			// Baseline versions may leak detached apps when interrupted during readiness.
			for (const pid of ownedAppPids)
				await terminateOwnedProcess({ pid } as ChildProcess, 1000);
			children.delete(child);
		}
	}
	const runtimeCalls = readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
	console.error(
		JSON.stringify({
			worker: index,
			runtimeCalls: runtimeCalls.length,
			reconciles: runtimeCalls.filter((args) => args.includes("up")).length,
		}),
	);
	return results;
}

try {
	const values = (
		await Promise.all(
			Array.from({ length: parallel }, (_, index) => worker(index)),
		)
	).flat();
	const quantiles = (numbers: number[]) => {
		const ordered = [...numbers].sort((a, b) => a - b);
		return {
			p50: Math.round(ordered[Math.floor((ordered.length - 1) * 0.5)]!),
			p95: Math.round(ordered[Math.ceil((ordered.length - 1) * 0.95)]!),
		};
	};
	console.log(
		JSON.stringify(
			{
				fixture:
					"real CLI and HTTP app; fake container runtime; hosts/tunnels/migrations disabled",
				bun: Bun.version,
				platform: process.platform,
				parallel,
				samples: values.length,
				appDelayMs: delay,
				entryToHttpReadyMs: quantiles(
					values.map((value) => value.readyResponseMs),
				),
				entryToCliReadyMs: quantiles(values.map((value) => value.cli!.totalMs)),
				values,
			},
			null,
			2,
		),
	);
} finally {
	await Promise.allSettled(
		[...children].map((child) => terminateOwnedProcess(child, 5000)),
	);
	rmSync(root, { recursive: true, force: true });
}
