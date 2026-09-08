import {
	copiedToken,
	deviceClient,
	readDevice,
	rotateDevice,
	setupDevice,
} from "../../core/connect/device";
import { helperAction, runConnectionHelper } from "../../core/connect/helper";
import { identifier } from "../../core/connect/protocol";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "../command-spec";

const flags = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show connection setup help",
	},
	json: {
		name: "--json",
		kind: "boolean",
		description: "Print machine-readable output",
	},
	session: {
		name: "--session",
		kind: "string",
		valueHint: "=<id>",
		description: "Remote session ID",
	},
	target: {
		name: "--target",
		kind: "string",
		valueHint: "=<id>",
		description: "Remote target ID",
	},
	all: {
		name: "--all",
		kind: "boolean",
		description: "With rotate, revoke existing sharing as well",
	},
} as const;
export const CONNECT_COMMAND_SPEC: CommandSpec = {
	usage:
		"buncargo connect <token|status|rotate|revoke|open|disconnect> [options]",
	flags: Object.values(flags),
	notes: [
		{
			command: "BUNCARGO_CONNECT_TOKENS",
			description:
				"Set copied tokens on a server to automatically share selected expose: true targets",
		},
	],
};
export async function handleConnect(args: string[]): Promise<void> {
	const errors: string[] = [];
	if (readBooleanFlag(args, flags.help)) {
		console.log(formatCommandHelp(CONNECT_COMMAND_SPEC));
		return;
	}
	const unknown = findUnknownFlags(CONNECT_COMMAND_SPEC, args);
	if (unknown.length)
		throw new Error(`Unknown connection flag: ${unknown.join(", ")}`);
	const command = args[0] ?? "status";
	const json = readBooleanFlag(args, flags.json);
	const session = readStringFlag(args, flags.session, errors),
		target = readStringFlag(args, flags.target, errors);
	if (errors.length) throw new Error(errors.join("\n"));
	switch (command) {
		case "token": {
			const device = await setupDevice();
			const token = copiedToken(device);
			console.log(json ? JSON.stringify({ token }) : token);
			return;
		}
		case "rotate": {
			const device = await rotateDevice(readBooleanFlag(args, flags.all));
			const token = copiedToken(device);
			console.log(json ? JSON.stringify({ token }) : token);
			return;
		}
		case "status": {
			const device = await readDevice();
			if (!device) {
				console.log(
					json
						? JSON.stringify({ version: 1, configured: false, runs: [] })
						: "Copy a connection token in BuncargoBar or run buncargo connect token.",
				);
				return;
			}
			const result = await deviceClient(device).list(
				device.recipientId,
				device.owner,
			);
			console.log(
				json
					? JSON.stringify({ ...result, configured: true })
					: result.runs
							.map(
								(r) =>
									`${r.project} / ${r.branch ?? r.worktree ?? "Main"} (${r.sessionId})\n${r.targets.map((t) => `  ${t.name}: ${t.status} (${t.protocol})`).join("\n")}`,
							)
							.join("\n") || "No shared environments",
			);
			return;
		}
		case "revoke": {
			if (!identifier(session)) throw new Error("Use --session=<id>");
			const device = await readDevice();
			if (!device) throw new Error("Create a connection token first");
			await deviceClient(device).withdraw(
				device.recipientId,
				session,
				device.owner,
			);
			console.log(json ? "{}" : "Sharing revoked");
			return;
		}
		case "open":
		case "disconnect": {
			if (!identifier(session) || !identifier(target))
				throw new Error("Use --session=<id> and --target=<id>");
			const result = await helperAction(command, session, target);
			console.log(
				json ? JSON.stringify(result) : (result.url ?? "Disconnected"),
			);
			return;
		}
		case "serve":
			await runConnectionHelper();
			return;
		default:
			throw new Error(
				"Unknown connection command; run buncargo connect --help",
			);
	}
}
