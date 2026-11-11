import { runConnectDaemon } from "../core/connect/daemon";
import { runCommand } from "./command-spec";
import { connectCommand } from "./commands/connect";

if (process.argv[2] === "connect")
	process.exitCode = await runCommand(connectCommand, process.argv.slice(3));
else await runConnectDaemon();
