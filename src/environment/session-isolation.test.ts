import { expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../core/process/lifecycle";
import { shellQuote } from "../core/shell-quote";
import { clearDevEnvCache, loadDevEnv } from "../loader";
import { createDevEnvironment } from "./create-dev-environment";

it("does not retain cancellation listeners across preparation-only starts", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo preparation listeners "));
	const caller = new AbortController();
	const env = createDevEnvironment(
		{
			projectPrefix: "preparation-listeners",
			services: {},
			apps: {},
			options: { verbose: false },
		},
		{ root },
	);
	try {
		for (let index = 0; index < 100; index++) {
			await env.start({ startServers: false, signal: caller.signal });
			expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		}
	} finally {
		await env.stop({ verbose: false });
		rmSync(root, { recursive: true, force: true });
	}
});

it("runs independent same-checkout sessions and stops only the session's own apps", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo sessions "));
	writeFileSync(join(root, "package.json"), '{"name":"sessions"}');
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default { projectPrefix: 'sessions', services: {}, apps: { one: { port: 3100, devCommand: ${JSON.stringify(`${process.execPath} -e 'Bun.serve({port:Number(process.env.PORT),fetch:()=>new Response("one")})'`)} }, two: { port: 3101, devCommand: ${JSON.stringify(`${process.execPath} -e 'Bun.serve({port:Number(process.env.PORT),fetch:()=>new Response("two")})'`)} } }, options: {verbose: false} };`,
	);
	const [first, second] = await Promise.all([
		loadDevEnv({ cwd: root, fresh: true }),
		loadDevEnv({ cwd: root, fresh: true }),
	]);
	try {
		await Promise.all([
			first.start({ onlyApps: ["one"], productionBuild: false }),
			second.start({ onlyApps: ["two"], productionBuild: false }),
		]);
		expect(await (await fetch(first.urls.one)).text()).toBe("one");
		await first.stop({ verbose: false });
		expect(await (await fetch(second.urls.two)).text()).toBe("two");
		await expect(fetch(first.urls.one)).rejects.toThrow();
	} finally {
		await Promise.allSettled([
			first.stop({ verbose: false }),
			second.stop({ verbose: false }),
		]);
		clearDevEnvCache();
		rmSync(root, { recursive: true, force: true });
	}
});

it("rejects overlapping starts on one mutable environment before changing its selection", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo start guard "));
	const controller = new AbortController();
	let entered!: () => void;
	const hookEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const env = createDevEnvironment(
		{
			projectPrefix: "start-guard",
			services: {},
			apps: { web: { port: 3000, devCommand: "exit 99" } },
			hooks: {
				beforeServers: async () => {
					entered();
					await new Promise(() => {});
				},
			},
			options: { verbose: false },
		},
		{ root },
	);
	try {
		const first = env
			.start({ signal: controller.signal, productionBuild: false })
			.then(
				() => undefined,
				(error) => error,
			);
		await hookEntered;
		await expect(env.start()).rejects.toThrow("already starting");
		controller.abort(new Error("cancel first start"));
		expect(await first).toMatchObject({ message: "cancel first start" });
	} finally {
		controller.abort();
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["start", "startServers"] as const)(
	"stop cancels a pending %s hook before any app can spawn",
	async (method) => {
		const root = mkdtempSync(join(tmpdir(), "buncargo stop startup "));
		let entered!: () => void;
		const hookEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const env = createDevEnvironment(
			{
				projectPrefix: "stop-startup",
				services: {},
				apps: { worker: { kind: "worker", devCommand: "exit 99" } },
				hooks: {
					beforeServers: async () => {
						entered();
						await new Promise(() => {});
					},
				},
				options: { verbose: false },
			},
			{ root },
		);
		const starting = env[method]({
			verbose: false,
			productionBuild: false,
		}).catch((error) => error);
		try {
			await hookEntered;
			await env.stop({ verbose: false });
			expect(await starting).toMatchObject({
				message: "Startup cancelled by stop",
			});
		} finally {
			await env.stop({ verbose: false });
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("stops the replacement worker after a capture restart in a library session", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo library restart "));
	const command = (file: string) =>
		`${shellQuote(process.execPath)} ${shellQuote(join(root, file))}`;
	writeFileSync(
		join(root, "source.ts"),
		`while (!(await Bun.file("trigger").exists())) await Bun.sleep(10); console.log("VALUE updated"); setInterval(() => {}, 1000);`,
	);
	writeFileSync(
		join(root, "dependent.ts"),
		`import {appendFileSync} from "node:fs"; appendFileSync("pids", String(process.pid)+"\\n"); setInterval(() => {}, 1000);`,
	);
	const env = createDevEnvironment(
		{
			projectPrefix: "library-restart",
			services: {},
			apps: {
				source: {
					kind: "worker",
					devCommand: command("source.ts"),
					captures: { value: { pattern: /VALUE (\S+)/, as: "value" } },
				},
				dependent: {
					kind: "worker",
					devCommand: command("dependent.ts"),
					restartOn: ["captured.value"],
				},
			},
			options: { verbose: false },
		},
		{ root },
	);
	const pids = () =>
		existsSync(join(root, "pids"))
			? readFileSync(join(root, "pids"), "utf8").trim().split("\n").map(Number)
			: [];
	try {
		await env.start({ verbose: false, productionBuild: false });
		const deadline = performance.now() + 3000;
		while (pids().length < 1 && performance.now() < deadline)
			await Bun.sleep(10);
		expect(pids()).toHaveLength(1);
		writeFileSync(join(root, "trigger"), "yes");
		while (pids().length < 2 && performance.now() < deadline)
			await Bun.sleep(10);
		expect(pids()).toHaveLength(2);
		await env.stop({ verbose: false });
		for (const pid of pids()) expect(isProcessAlive(pid)).toBe(false);
	} finally {
		await env.stop({ verbose: false });
		rmSync(root, { recursive: true, force: true });
	}
});
