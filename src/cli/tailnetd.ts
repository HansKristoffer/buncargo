import { runTailnetDaemon } from "../core/tailnet/daemon";
import { handleTailnet } from "./commands/tailnet";

// The saved menu command uses the same self-contained bundle without starting a publisher.
if (process.argv[2] === "tailnet") await handleTailnet(process.argv.slice(3));
else await runTailnetDaemon();
