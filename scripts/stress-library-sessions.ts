/** Repeated library sessions in one process; all child processes and state are isolated. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { withFileLock } from "../src/core/file-lock";
import { isProcessAlive } from "../src/core/process/lifecycle";
import { readAllRuns } from "../src/core/run-registry";
import { shellQuote } from "../src/core/shell-quote";
import { clearDevEnvCache, loadDevEnv } from "../src/loader";
import type { AnyDevEnvironment } from "../src/types";

const option = (name: string, fallback: number) =>
	Number(
		process.argv
			.find((arg) => arg.startsWith(`--${name}=`))
			?.slice(name.length + 3) ?? fallback,
	);
const sessions = option("sessions", 200);
const concurrency = option("concurrency", 4);
const maxHeapGrowthMiB = option("max-heap-growth-mib", 24);
const maxRssGrowthMiB = option("max-rss-growth-mib", 96);
for (const value of [sessions, concurrency, maxHeapGrowthMiB, maxRssGrowthMiB])
	assert(
		Number.isInteger(value) && value > 0,
		"Stress options must be positive integers",
	);

const root = mkdtempSync(join(tmpdir(), "buncargo session stress "));
const active = new Set<AnyDevEnvironment>();
const sessionIds = new Set<string>();
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const listeners = () => signals.map((signal) => process.listenerCount(signal));
const baselineListeners = listeners();
const interrupted = new AbortController();
const onInt = () => interrupted.abort(new Error("Stress run interrupted"));
process.once("SIGINT", onInt);
process.once("SIGTERM", onInt);
const expectedListeners = listeners();

function descriptors(): number | undefined {
	try {
		return readdirSync(
			process.platform === "linux" ? "/proc/self/fd" : "/dev/fd",
		).length;
	} catch {
		return undefined;
	}
}
function memory() {
	Bun.gc(true);
	const { heapUsed, rss } = process.memoryUsage();
	return { heapUsed, rss, descriptors: descriptors() };
}
async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}
async function waitFor(test: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = performance.now() + 5000;
	while (!(await test())) {
		interrupted.signal.throwIfAborted();
		assert(
			performance.now() < deadline,
			"Session did not reach the expected state",
		);
		await Bun.sleep(5);
	}
}

interface Fixture {
	root: string;
	pids(): number[];
}
async function prepare(index: number): Promise<Fixture> {
	const checkout = join(root, `project-${index}`);
	mkdirSync(checkout);
	const log = join(checkout, "pids");
	writeFileSync(join(checkout, "package.json"), "{}");
	writeFileSync(
		join(checkout, "app.ts"),
		`
		import {appendFileSync} from "node:fs";
		appendFileSync("pids", String(process.pid)+"\\n");
		if (process.env.PORT) Bun.serve({port:Number(process.env.PORT),hostname:"127.0.0.1",fetch:()=>new Response("ready",{status:process.env.BLOCKED ? 503 : 200})});
		else setInterval(()=>{},1000);
	`,
	);
	const command = `${shellQuote(process.execPath)} ${shellQuote(join(checkout, "app.ts"))}`;
	writeFileSync(
		join(checkout, "dev.config.ts"),
		`export default {
		projectPrefix: "stress-${index}", services: {},
		apps: {
			web: {port:${await unusedPort()},devCommand:${JSON.stringify(command)},healthEndpoint:"/"},
			blocked: {port:${await unusedPort()},devCommand:${JSON.stringify(command)},healthEndpoint:"/",staticEnv:{BLOCKED:"1"}},
			worker: {kind:"worker",devCommand:${JSON.stringify(command)}}
		}, options:{verbose:false,worktreeIsolation:false}
	};`,
	);
	return {
		root: checkout,
		pids: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(Number)
				: [],
	};
}

async function cycle(fixture: Fixture, index: number): Promise<void> {
	interrupted.signal.throwIfAborted();
	const env = await loadDevEnv({ cwd: fixture.root, fresh: true });
	assert(!sessionIds.has(env.sessionId), "Fresh sessions shared an identity");
	sessionIds.add(env.sessionId);
	active.add(env);
	const caller = new AbortController();
	const cancel = () => caller.abort(interrupted.signal.reason);
	interrupted.signal.addEventListener("abort", cancel, { once: true });
	try {
		if (index % 5 === 0) {
			const before = fixture.pids().length;
			const pending = env
				.start({
					onlyApps: ["blocked"],
					productionBuild: false,
					signal: caller.signal,
				})
				.then(
					() => undefined,
					(error) => error,
				);
			await waitFor(() => fixture.pids().length > before);
			await env.stop({ verbose: false });
			assert.match((await pending)?.message ?? "", /Startup cancelled by stop/);
		} else {
			const options = {
				onlyApps: ["web", "worker"],
				productionBuild: false,
				verbose: false,
				signal: caller.signal,
			};
			const pids =
				index % 2 ? await env.start(options) : await env.startServers(options);
			assert(
				pids && Object.keys(pids).length === 2,
				"Session did not own both apps",
			);
			assert.equal((await fetch(env.urls.web)).status, 200);
			if (index % 3 === 0) caller.abort(new Error("Cancel ready session"));
			await env.stop({ verbose: false });
			for (const pid of Object.values(pids))
				assert(!isProcessAlive(pid), `Owned group ${pid} survived stop`);
		}
		for (const pid of fixture.pids())
			assert(!isProcessAlive(pid), `App ${pid} leaked across sessions`);
		assert.equal(
			getEventListeners(caller.signal, "abort").length,
			0,
			"Caller cancellation listener leaked",
		);
		await withFileLock(
			join(fixture.root, ".buncargo/workers.json"),
			async () => {},
			{ timeoutMs: 0 },
		);
	} finally {
		caller.abort();
		interrupted.signal.removeEventListener("abort", cancel);
		await env.stop({ verbose: false });
		active.delete(env);
	}
}

try {
	const home = join(root, "home");
	const binaries = join(root, "bin");
	mkdirSync(home);
	mkdirSync(binaries);
	for (const name of ["docker", "container"]) {
		const binary = join(binaries, name);
		writeFileSync(
			binary,
			`#!/bin/sh\necho invoked >> ${shellQuote(join(root, "runtime-called"))}\nexit 1\n`,
		);
		chmodSync(binary, 0o700);
	}
	process.env.HOME = home;
	process.env.PATH = binaries + delimiter + process.env.PATH;
	process.env.DOCKER_HOST = "unix:///buncargo-stress-no-daemon.sock";
	process.env.BUNCARGO_PORT_OFFSET = "0";
	delete process.env.BUNCARGO_CONNECT_TOKENS;
	const fixtures = await Promise.all(
		Array.from({ length: concurrency }, (_, index) => prepare(index)),
	);
	// Warm the loader, FFI locks and process machinery before measuring retained memory.
	await Promise.all(
		fixtures.map((fixture, index) => cycle(fixture, index + 1)),
	);
	await Bun.sleep(0);
	const baseline = memory();
	const samples = [baseline];
	let completed = 0;
	while (completed < sessions) {
		const batch = fixtures.slice(
			0,
			Math.min(concurrency, sessions - completed),
		);
		const outcomes = await Promise.allSettled(
			batch.map((fixture, index) => cycle(fixture, completed + index)),
		);
		for (const outcome of outcomes)
			if (outcome.status === "rejected") throw outcome.reason;
		completed += batch.length;
		assert.deepEqual(
			listeners(),
			expectedListeners,
			"Process signal listeners grew across sessions",
		);
		assert(
			!existsSync(join(root, "runtime-called")),
			"An app-only session invoked a container runtime",
		);
		assert.equal(
			(await readAllRuns()).length,
			0,
			"An app-only session left a container claim",
		);
		if (completed % 20 === 0 || completed === sessions) samples.push(memory());
	}
	clearDevEnvCache();
	const final = memory();
	const heapGrowthMiB =
		Math.max(
			0,
			...samples.map((sample) => sample.heapUsed - baseline.heapUsed),
			final.heapUsed - baseline.heapUsed,
		) /
		1024 ** 2;
	const rssGrowthMiB =
		Math.max(
			0,
			...samples.map((sample) => sample.rss - baseline.rss),
			final.rss - baseline.rss,
		) /
		1024 ** 2;
	assert(
		heapGrowthMiB <= maxHeapGrowthMiB,
		`Retained heap grew by ${heapGrowthMiB.toFixed(1)} MiB`,
	);
	assert(
		rssGrowthMiB <= maxRssGrowthMiB,
		`RSS grew by ${rssGrowthMiB.toFixed(1)} MiB`,
	);
	if (baseline.descriptors !== undefined && final.descriptors !== undefined)
		assert(
			final.descriptors <= baseline.descriptors + 4,
			"Open file descriptors leaked",
		);
	console.log(
		JSON.stringify({
			sessions,
			concurrency,
			heapGrowthMiB,
			rssGrowthMiB,
			baseline,
			final,
			samples,
			uniqueSessions: sessionIds.size,
		}),
	);
} finally {
	interrupted.abort();
	await Promise.allSettled(
		[...active].map((env) => env.stop({ verbose: false })),
	);
	clearDevEnvCache();
	process.off("SIGINT", onInt);
	process.off("SIGTERM", onInt);
	assert.deepEqual(listeners(), baselineListeners);
	rmSync(root, { recursive: true, force: true });
}
