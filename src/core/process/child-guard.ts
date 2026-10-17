import { type ChildProcess, spawn } from "node:child_process";
import { connectProcessEnv } from "../child-env";

/**
 * A small parent between buncargo and a long-lived tool (frpc, cloudflared).
 * EOF on the stdin buncargo holds stops the tool, so it dies with buncargo
 * even on SIGKILL, which no signal handler of ours can catch.
 *
 * argv: the directory to remove on exit (or ""), where the tool's output goes
 * (`ignore`, or `inherit` to hand it the guard's own stdout/stderr), then the
 * tool and its arguments.
 */
export const CHILD_GUARD = `
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");
const [directory, output, binary, ...args] = process.argv.slice(1);

function finish(code) {
  try {
    if (directory) rmSync(directory, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

const child = spawn(binary, args, { stdio: ["ignore", output, output] });
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1000).unref();
}

process.stdin.resume();
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => finish(1));
child.on("exit", (code) => finish(code ?? 1));
`;

/**
 * Spawn `binary` under a {@link CHILD_GUARD}. The returned process is the
 * guard: its exit is the tool's, and with `output: "pipe"` its stdout/stderr
 * carry the tool's output.
 *
 * `detached` puts the guard and the tool in a process group of their own, so
 * `terminateOwnedProcess` can signal both at once.
 */
export function spawnGuarded(
	binary: string,
	args: string[],
	options: {
		directory?: string;
		output?: "ignore" | "pipe";
		detached?: boolean;
	} = {},
): ChildProcess {
	const output = options.output ?? "ignore";
	const child = spawn(
		process.execPath,
		[
			"-e",
			CHILD_GUARD,
			"--",
			options.directory ?? "",
			output === "pipe" ? "inherit" : "ignore",
			binary,
			...args,
		],
		{
			env: connectProcessEnv(),
			stdio: ["pipe", output, output],
			detached: options.detached ?? false,
		},
	);
	child.stdin?.on("error", () => {});
	return child;
}

/** Keep the guard alive until its child exits; closing stdin also works before the guard starts. */
export function startGuardedChild(
	binary: string,
	args: string[],
	directory = "",
) {
	const child = spawnGuarded(binary, args, { directory });
	let alive = true;
	const finished = new Promise<void>((resolve) => {
		const done = () => {
			alive = false;
			resolve();
		};
		child.once("exit", done);
		child.once("error", done);
	});
	return {
		get alive() {
			return alive;
		},
		async close() {
			child.stdin?.end();
			await finished;
		},
	};
}
