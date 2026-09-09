/** EOF on the coordinator-owned stdin also handles SIGKILL: never leave an orphan userspace node. */
export const CHILD_GUARD = `
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");
const directory = process.argv[1];
function finish(code) {
 try { rmSync(directory, { recursive: true, force: true }); } catch {}
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
