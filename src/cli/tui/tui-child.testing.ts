// Started under a pseudo-terminal by run-tui.test.ts: takes the screen, then
// dies the way the argument says, so the test can check what is left behind.
import { writeSync } from "node:fs";
import { RunOutput } from "../../core/process/run-output";
import { RunTui } from "./run-tui";

const output = new RunOutput();
const tui = new RunTui({
	output,
	apps: ["api"],
	urlFor: () => undefined,
	quit: () => process.exit(0),
});
process.on("SIGTERM", () => process.exit(143));
// Before the TUI captures stdout: the test signals this pid, and only it.
writeSync(1, `pid:${process.pid}\n`);
tui.start();
output.line("api", "hello from api");
console.log("captured, not drawn over the frame");
setTimeout(() => {
	if (process.argv[2] === "throw") throw new Error("boom");
	if (process.argv[2] === "reject") void Promise.reject(new Error("rejected"));
	if (process.argv[2] === "exit") process.exit(1);
}, 300);
setInterval(() => {}, 1000);
