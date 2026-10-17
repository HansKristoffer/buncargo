// Started under a pseudo-terminal by run-tui.test.ts: takes the screen, then
// dies the way the argument says, so the test can check what is left behind.
// `pager <path>` instead opens `l` on that pager and stands in for a run: a
// SIGINT that reaches it ends it, as one ends `buncargo dev`.
import { writeSync } from "node:fs";
import { RunOutput } from "../../core/process/run-output";
import { RunTui } from "./run-tui";

const [how, pager] = process.argv.slice(2);
if (pager) process.env.PAGER = pager;
const output = new RunOutput();
const tui = new RunTui({
	output,
	apps: ["api"],
	urlFor: () => undefined,
	logPath: () => import.meta.path,
	quit: () => process.exit(0),
});
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => {
	tui.stop();
	writeSync(1, "run interrupted\n");
	process.exit(130);
});
// Before the TUI captures stdout: the test signals this pid, and only it.
writeSync(1, `pid:${process.pid}\n`);
tui.start();
output.line("api", "hello from api");
console.log("captured, not drawn over the frame");
setTimeout(() => {
	if (how === "throw") throw new Error("boom");
	if (how === "reject") void Promise.reject(new Error("rejected"));
	if (how === "exit") process.exit(1);
}, 300);
setInterval(() => {}, 1000);
