/**
 * The parent holds stdin open. EOF means the CLI/helper died, including SIGKILL;
 * terminate Tailcat so an orphan cannot expose a gate port later reused by another app.
 * This fixed program receives argv directly; no shell or remote code is evaluated.
 */
export const TAILCAT_GUARD = `
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit"] });
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
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
`;
