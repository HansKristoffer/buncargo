/** Isolated end-to-end dev benchmark: real CLI/apps, deterministic fake runtime. */
import { spawn, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { readProcessIdentity } from "../src/core/process-identity";
import { computeBaseOffset } from "../src/core/port-allocation";
import { terminateOwnedProcess } from "../src/core/process/terminate";

const option = (name: string, fallback: string) =>
	process.argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3) ?? fallback;
const cli = resolve(option("cli", "dist/cli/bin.js"));
const samples = Number(option("samples", "10"));
const parallel = Number(option("parallel", "1"));
const delay = Number(option("app-delay", "120"));
const scenario = option("scenario", "services");
const sameCheckout = process.argv.includes("--same-checkout");
if (sameCheckout && scenario !== "reuse")
	throw new Error(
		"--same-checkout requires --scenario=reuse (one shared app owner)",
	);
const appCount = Number(option("apps", "1"));
const maxColdP95 = Number(option("max-cold-p95", "Infinity"));
const maxP95 = Number(option("max-p95", "Infinity"));
const maxSubprocesses = Number(option("max-subprocesses", "Infinity"));
for (const budget of [maxP95, maxColdP95, maxSubprocesses])
	if (!(budget > 0)) throw new Error("Performance budgets must be positive");
if (
	![
		"services",
		"apps",
		"allocation",
		"workers",
		"preparation",
		"reuse",
		"cancel",
	].includes(scenario)
)
	throw new Error(`Unknown scenario: ${scenario}`);
const legacy = process.argv.includes("--legacy");
for (const [name, value] of Object.entries({
	samples,
	parallel,
	delay,
	appCount,
}))
	if (!Number.isInteger(value) || value < (name === "delay" ? 0 : 1))
		throw new Error(`Invalid ${name}`);
const root = mkdtempSync(join(tmpdir(), "buncargo startup benchmark "));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();
const cold: Result[] = [];

const interruption = new AbortController();
let interruptCode: number | undefined;
const onInt = () => {
	interruptCode = 130;
	interruption.abort(new Error("Benchmark interrupted"));
};
const onTerm = () => {
	interruptCode = 143;
	interruption.abort(new Error("Benchmark interrupted"));
};
process.once("SIGINT", onInt);
process.once("SIGTERM", onTerm);

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
	readyResponseMs?: number;
	cleanupMs?: number;
	cli?: {
		totalMs: number;
		phases: unknown[];
		counters?: Record<string, number>;
	};
}
async function prepareWorker(
	index: number,
): Promise<(workerIndex: number) => Promise<Result[]>> {
	interruption.signal.throwIfAborted();
	const { mkdirSync } = await import("node:fs");
	const project = join(root, `checkout-${index}`);
	mkdirSync(project);
	const offset =
		scenario === "allocation"
			? computeBaseOffset({
					projectPrefix: `bench-${index}`,
					worktreeIsolation: false,
				})
			: 0;
	const port = scenario === "allocation" ? 3000 + offset : await unusedPort();
	const servicePort = scenario === "allocation" ? 5432 : await unusedPort();
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
		`const began=performance.now(); Bun.serve({port:Number(process.env.PORT), hostname:'127.0.0.1', fetch(){return new Response('ready',{status:performance.now()-began>=${scenario === "cancel" ? 60000 : delay}?200:503});}});`,
	);
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: `benchmark-${index}`, private: true }),
	);
	const apps: Record<string, object> = {};
	for (let appIndex = 0; appIndex < appCount; appIndex++) {
		const name = appIndex === 0 ? "web" : `web${appIndex}`;
		const appPort =
			appIndex === 0
				? port
				: scenario === "allocation"
					? port + appIndex
					: await unusedPort();
		apps[name] =
			scenario === "workers"
				? {
						kind: "worker",
						devCommand: `${quote(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
						requiredServices: [],
					}
				: {
						port: appPort - offset,
						devCommand: `${quote(process.execPath)} ${quote(app)}`,
						requiredServices:
							scenario === "apps" || scenario === "reuse" ? [] : ["postgres"],
						healthEndpoint: "/ready",
					};
	}
	writeFileSync(
		join(project, "dev.config.ts"),
		`export default ${JSON.stringify({
			projectPrefix: `bench-${index}`,
			services: { postgres: { port: servicePort, healthCheck: false } },
			apps,
			docker: { runtime: "docker", binary },
			...(scenario === "preparation"
				? {
						migrations: [
							{
								name: "migrate",
								command: `${quote(process.execPath)} -e 'void 0'`,
								requiredServices: ["postgres"],
							},
						],
						seed: {
							command: `${quote(process.execPath)} -e 'void 0'`,
							requiredServices: ["postgres"],
						},
					}
				: {}),
			options: {
				hosts: false,
				autoShutdown: false,
				verbose: false,
				worktreeIsolation: false,
			},
		})};`,
	);
	if (scenario === "reuse") {
		for (const appConfig of Object.values(apps)) {
			const reused = spawn(process.execPath, [app], {
				cwd: project,
				detached: true,
				stdio: "ignore",
				env: {
					...process.env,
					PORT: String((appConfig as { port: number }).port),
				},
			});
			children.add(reused);
		}
		const deadline = performance.now() + 5000;
		while (true) {
			interruption.signal.throwIfAborted();
			try {
				if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) break;
			} catch {}
			if (performance.now() > deadline)
				throw new Error("Reuse fixture never started");
			await sleep(10);
		}
	}

	const readyFile = join(project, "cli-ready");
	const runner = join(project, "runner.ts");
	const packageRoot = resolve(cli, "../../..");
	writeFileSync(
		runner,
		`import {loadDevEnv} from ${JSON.stringify(join(packageRoot, "dist/loader/index.js"))}; import {runCli} from ${JSON.stringify(join(packageRoot, "dist/cli/index.js"))}; import {writeFileSync} from 'node:fs'; const env=await loadDevEnv(); const wait=env.waitForServers.bind(env); env.waitForServers=async options=>{await wait(options); writeFileSync(${JSON.stringify(readyFile)}, String(performance.now()));}; await runCli(env,{args:process.argv.slice(2)});`,
	);
	return async (workerIndex) => {
		const results: Result[] = [];
		// The first iteration warms the generated file/runtime and is reported separately.
		for (let sample = 0; sample <= samples; sample++) {
			interruption.signal.throwIfAborted();
			let output = "";
			let report: Result["cli"];
			const ownedAppPids = new Set<number>();
			let readyResponseMs: number | undefined;
			let cancelledAt: number | undefined;
			let cleanupMs: number | undefined;
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
						BUNCARGO_PORT_OFFSET: scenario === "allocation" ? undefined : "0",
						DOCKER_HOST: `unix://${join(root, "unavailable-docker.sock")}`,
						BUNCARGO_CONNECT_TOKENS: undefined,
						BUNCARGO_CONTAINER_RUNTIME: "docker",
						BUNCARGO_CONTAINER_BINARY: undefined,
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
				for (const match of output.matchAll(/PID:\s*(\d+)/g))
					ownedAppPids.add(Number(match[1]));
				for (const line of output.split("\n")) {
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
					interruption.signal.throwIfAborted();
					if (
						child.exitCode !== null &&
						child.exitCode !== (scenario === "cancel" ? 130 : 0)
					)
						throw new Error(`CLI exited ${child.exitCode}: ${output}`);
					if (
						scenario === "cancel" &&
						cancelledAt === undefined &&
						ownedAppPids.size > 0
					) {
						cancelledAt = performance.now();
						child.kill("SIGINT");
					}
					if (cancelledAt !== undefined && child.exitCode !== null)
						cleanupMs = performance.now() - cancelledAt;
					try {
						const effectivePort =
							scenario === "allocation" &&
							existsSync(join(project, ".buncargo/ports.json"))
								? JSON.parse(
										readFileSync(join(project, ".buncargo/ports.json"), "utf8"),
									).ports.web
								: port;
						const response = await fetch(
							`http://127.0.0.1:${effectivePort}/ready`,
							{
								signal: AbortSignal.timeout(100),
							},
						);
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
					if (
						report &&
						(scenario === "workers" ||
							(scenario === "cancel"
								? cleanupMs !== undefined
								: readyResponseMs !== undefined))
					)
						break;
					await sleep(10);
				}
				if (
					!report ||
					(scenario !== "workers" &&
						scenario !== "cancel" &&
						readyResponseMs === undefined)
				)
					throw new Error(`Startup timed out: ${output}`);
				const result = {
					wallMs: performance.now() - began,
					readyResponseMs,
					cleanupMs,
					cli: report,
				};
				if (sample === 0) {
					cold.push(result);
					console.error(
						JSON.stringify({
							worker: workerIndex,
							scenario: "cold fixture",
							...result,
						}),
					);
				} else results.push(result);
			} finally {
				await terminateOwnedProcess(child, 5000);
				// Baseline versions may leak detached apps when interrupted during readiness.
				for (const pid of ownedAppPids)
					await terminateOwnedProcess({ pid } as ChildProcess, 1000);
				children.delete(child);
			}
		}
		const runtimeCalls = (existsSync(log) ? readFileSync(log, "utf8") : "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);
		if (
			["apps", "workers", "reuse"].includes(scenario) &&
			runtimeCalls.length > 0
		)
			throw new Error(
				`App-only scenario invoked a runtime ${runtimeCalls.length} times`,
			);
		console.error(
			JSON.stringify({
				worker: workerIndex,
				runtimeCalls: runtimeCalls.length,
				reconciles: runtimeCalls.filter((args) => args.includes("up")).length,
			}),
		);
		return results;
	};
}

try {
	// An owned sentinel stands in for the machine watchdog. No detached sweep can
	// outlive the fake binaries or see the developer's real container daemons.
	mkdirSync(join(root, ".buncargo"));
	const sentinel = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{ detached: true, stdio: "ignore" },
	);
	children.add(sentinel);
	await new Promise<void>((resolve, reject) => {
		sentinel.once("spawn", resolve);
		sentinel.once("error", reject);
	});
	const identity = readProcessIdentity(sentinel.pid!);
	if (!identity) throw new Error("Cannot identify benchmark watchdog sentinel");
	writeFileSync(
		join(root, ".buncargo/watchdog.pid"),
		JSON.stringify({ pid: sentinel.pid, processIdentity: identity }),
	);

	const sharedWorker = sameCheckout ? await prepareWorker(0) : undefined;
	const outcomes = await Promise.allSettled(
		Array.from({ length: parallel }, async (_, index) => {
			const run = sharedWorker ?? (await prepareWorker(index));
			return run(index);
		}),
	);
	const values = outcomes.flatMap((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});

	const quantiles = (numbers: number[]) => {
		const ordered = [...numbers].sort((a, b) => a - b);
		return {
			p50: Math.round(ordered[Math.floor((ordered.length - 1) * 0.5)]!),
			p95: Math.round(ordered[Math.ceil((ordered.length - 1) * 0.95)]!),
		};
	};
	const cliReady = quantiles(values.map((value) => value.cli!.totalMs));
	const coldReady = quantiles(cold.map((value) => value.cli!.totalMs));
	if (coldReady.p95 > maxColdP95)
		throw new Error(
			`Cold startup budget exceeded: ${coldReady.p95}ms (max ${maxColdP95})`,
		);
	const subprocesses = Math.max(
		...values.map((value) => value.cli?.counters?.subprocesses ?? 0),
	);
	if (cliReady.p95 > maxP95 || subprocesses > maxSubprocesses)
		throw new Error(
			`Startup budget exceeded: p95=${cliReady.p95}ms (max ${maxP95}); subprocesses=${subprocesses} (max ${maxSubprocesses})`,
		);
	console.log(
		JSON.stringify(
			{
				fixture:
					"real CLI/apps; fake container runtime and watchdog; hosts/tunnels disabled",
				scenario,
				appCount,
				subprocesses,
				bun: Bun.version,
				platform: process.platform,
				parallel,
				sameCheckout,
				samples: values.length,
				appDelayMs: delay,
				entryToHttpReadyMs: values.some(
					(value) => value.readyResponseMs !== undefined,
				)
					? quantiles(
							values.flatMap((value) =>
								value.readyResponseMs === undefined
									? []
									: [value.readyResponseMs],
							),
						)
					: undefined,
				entryToCliReadyMs: scenario === "cancel" ? undefined : cliReady,
				cleanupMs:
					scenario === "cancel"
						? quantiles(values.map((value) => value.cleanupMs!))
						: undefined,
				coldEntryToCliReadyMs: scenario === "cancel" ? undefined : coldReady,
				cold,
				values,
			},
			null,
			2,
		),
	);
} catch (error) {
	if (interruptCode !== undefined) process.exitCode = interruptCode;
	else throw error;
} finally {
	process.off("SIGINT", onInt);
	process.off("SIGTERM", onTerm);
	await Promise.allSettled(
		[...children].map((child) => terminateOwnedProcess(child, 5000)),
	);
	rmSync(root, { recursive: true, force: true });
}
