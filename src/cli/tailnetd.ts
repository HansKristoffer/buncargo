import { runTailnetDaemon } from "../core/tailnet/daemon";

runTailnetDaemon().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
