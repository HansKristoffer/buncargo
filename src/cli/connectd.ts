import { runConnectDaemon } from "../core/connect/daemon";
import { handleConnect } from "./commands/connect";

if (process.argv[2] === "connect") await handleConnect(process.argv.slice(3));
else await runConnectDaemon();
