import { spawn } from "node:child_process";
import { tailscaleProcessEnv } from "../runtime-flags";

/** EOF on the coordinator-owned stdin also handles SIGKILL for both Serve and userspace nodes. */
export const CHILD_GUARD = `
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");
const directory = process.argv[1];
function finish(code) {
 try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch {}
 process.exit(code);
}
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: "ignore" });
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

/** Keep the guard alive until its child exits; closing stdin also works before the guard starts. */
export function startGuardedChild(
	binary: string,
	args: string[],
	directory = "",
) {
	const child = spawn(
		process.execPath,
		["-e", CHILD_GUARD, "--", directory, binary, ...args],
		{
			env: tailscaleProcessEnv(),
			stdio: ["pipe", "ignore", "ignore"],
		},
	);
	let alive = true;
	const finished = new Promise<void>((resolve) => {
		const done = () => {
			alive = false;
			resolve();
		};
		child.once("exit", done);
		child.once("error", done);
	});
	child.stdin.on("error", () => {});
	return {
		get alive() {
			return alive;
		},
		async close() {
			child.stdin.end();
			await finished;
		},
	};
}
