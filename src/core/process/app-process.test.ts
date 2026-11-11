import { expect, it } from "bun:test";
import type { EventEmitter } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApp } from "../../config/resolve";
import { readProcessIdentityAsync } from "../process-identity";
import { shellQuote } from "../shell-quote";
import { AppLogs } from "./app-logs";
import { spawnManagedApp } from "./app-process";
import { isProcessAlive } from "./lifecycle";
import { PtyApp } from "./pty-app";
import { printStream, RunOutput } from "./run-output";
import { terminateProcessGroup } from "./terminate";

async function until(condition: () => boolean, what: string, ms = 10_000) {
	const deadline = performance.now() + ms;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error(`Timed out on ${what}`);
		await Bun.sleep(20);
	}
}

/**
 * `devCommand` as the attached app of a stream-mode run started from a real
 * terminal, writing its log as `dev` does: a harness runs `spawnManagedApp`
 * under a pseudo-terminal of its own, writes the app's pid to `app.pid`, and once the app exits writes the
 * lines it fed the run and whether its terminal was left raw to `result.json`.
 */
function attachedInTerminal(dir: string, devCommand: string) {
	const harness = join(dir, "harness.ts");
	const module = (path: string) => JSON.stringify(join(import.meta.dir, path));
	writeFileSync(
		harness,
		`import { resolveApp } from ${module("../../config/resolve")};
import { spawnManagedApp } from ${module("./app-process")};
import { AppLogs } from ${module("./app-logs")};
import { RunOutput } from ${module("./run-output")};
const output = new RunOutput({ terminals: "pipe", logs: new AppLogs(${JSON.stringify(dir)}, "run") });
const lines: unknown[] = [];
output.subscribe({ line: ({ text, echoed }) => lines.push({ text, echoed }) });
const app = spawnManagedApp("web", resolveApp({ port: 3000, devCommand: ${JSON.stringify(devCommand)} }), ${JSON.stringify(dir)}, {}, {
	attached: true, extraArgs: [], productionBuild: false, waitForExit: true, output,
});
await Bun.write(${JSON.stringify(join(dir, "app.pid"))}, String(app.pid));
app.once("exit", async () => {
	await Bun.write(${JSON.stringify(join(dir, "result.json"))}, JSON.stringify({ lines, rawAfterExit: process.stdin.isRaw }));
	process.exit(0);
});
`,
	);
	const decoder = new TextDecoder();
	let printed = "";
	const pty = new PtyApp([process.execPath, harness], {
		cwd: dir,
		env: process.env,
		cols: 80,
		rows: 24,
		onData: (data) => {
			printed += decoder.decode(data, { stream: true });
		},
	});
	return {
		pty,
		/** What reached the terminal. */
		printed: () => printed,
		close: () => {
			if (isProcessAlive(-pty.pid)) process.kill(-pty.pid, "SIGKILL");
		},
	};
}

it("passes attached arguments literally, including shell syntax and empty values", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo literal args "));
	const script = join(root, "record args.ts");
	writeFileSync(
		script,
		"await Bun.write('args.json', JSON.stringify(process.argv.slice(2)));",
	);
	const args = [
		"two words",
		"",
		"'quoted'",
		'"double"',
		"$(echo substituted)",
		"; echo injected",
		"*.ts",
		"a\\b",
		"--flag=value",
	];
	try {
		const child = spawnManagedApp(
			"web",
			resolveApp({
				port: 3000,
				devCommand: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
			}),
			root,
			{},
			{
				attached: true,
				extraArgs: args,
				productionBuild: false,
				waitForExit: true,
				output: new RunOutput({ terminals: "pipe" }),
			},
		) as EventEmitter;
		const code = await new Promise((resolve, reject) => {
			child.once("exit", resolve);
			child.once("error", reject);
		});
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "args.json"), "utf8"))).toEqual(
			args,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("gives an attached app without a terminal one of its own: printed once, logged", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo attached log "));
	try {
		const logs = new AppLogs(root, "attached");
		const output = new RunOutput({ terminals: "pipe", logs });
		let printed = "";
		printStream(output, {
			width: 3,
			write: (text) => {
				printed += text;
			},
		});
		const child = spawnManagedApp(
			"web",
			resolveApp({ port: 3000, devCommand: "echo hello from web" }),
			root,
			{},
			{
				attached: true,
				extraArgs: [],
				productionBuild: false,
				waitForExit: true,
				output,
			},
		) as EventEmitter;
		await new Promise((resolve) => child.once("exit", resolve));
		// close() waits for every screen to flush before it writes the logs.
		await output.close();
		expect(readFileSync(logs.file("web"), "utf8")).toContain("hello from web");
		// Through the screen and the stream printer, never also raw.
		expect(printed.split("hello from web")).toHaveLength(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("stops everything an attached app on a real terminal started, even what ignores the hangup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "buncargo attached stop "));
	const serverPid = join(dir, "server.pid");
	// The shell stays as the parent, as with `bun run dev`: the server is a
	// grandchild that only the app's process group reaches.
	const devCommand = `sh -c 'trap "" HUP; echo $$ > server.pid; exec sleep 60'; true`;
	const terminal = attachedInTerminal(dir, devCommand);
	let server: number | undefined;
	try {
		await until(
			() => existsSync(serverPid) && existsSync(join(dir, "app.pid")),
			"the server to start",
		);
		server = Number(readFileSync(serverPid, "utf8"));
		const app = Number(readFileSync(join(dir, "app.pid"), "utf8"));
		const identity = await readProcessIdentityAsync(app);
		if (!identity) throw new Error(`no identity for pid ${app}`);

		// What `buncargo stop` does with the pid the run registered.
		expect(await terminateProcessGroup(app, identity, 1000)).toBe(true);

		expect(isProcessAlive(server)).toBe(false);
	} finally {
		if (server !== undefined && isProcessAlive(server))
			process.kill(server, "SIGKILL");
		terminal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

it("passes the terminal through to an attached app: keys in, output out once, logged, and the terminal given back", async () => {
	const dir = mkdtempSync(join(tmpdir(), "buncargo attached keys "));
	const devCommand = `printf 'ready\\n'; IFS= read -r line; printf 'got:%s\\n' "$line"`;
	const terminal = attachedInTerminal(dir, devCommand);
	const result = join(dir, "result.json");
	try {
		await until(() => terminal.printed().includes("ready"), "the prompt");
		terminal.pty.write("typed\r");
		await until(() => existsSync(result), "the app to exit");

		expect(terminal.printed().split("got:typed")).toHaveLength(2);
		const { lines, rawAfterExit } = JSON.parse(readFileSync(result, "utf8"));
		expect(lines).toContainEqual({ text: "got:typed", echoed: true });
		expect(rawAfterExit).toBe(false);
	} finally {
		terminal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
