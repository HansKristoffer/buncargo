import { matchesProcessIdentity } from "../../core/process-identity";
import { createTailscaleClient } from "../../core/tailnet/client";
import {
	isCoordinatorReady,
	readCoordinatorState,
} from "../../core/tailnet/coordinator-state";
import { discoverTailnet } from "../../core/tailnet/discovery";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
} from "../command-spec";

const flags = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show Tailscale discovery help",
	},
	json: {
		name: "--json",
		kind: "boolean",
		description: "Print machine-readable output",
	},
} as const;
export const TAILNET_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo tailnet status [--json]",
	flags: Object.values(flags),
	notes: [
		{
			command: "TS_AUTHKEY",
			description:
				"Cloud runtime secret: automatically install Tailscale and sign in when starting dev. Existing connected machines share automatically.",
		},
	],
};
export async function handleTailnet(args: string[]) {
	if (readBooleanFlag(args, flags.help)) {
		console.log(formatCommandHelp(TAILNET_COMMAND_SPEC));
		return;
	}
	const unknown = findUnknownFlags(TAILNET_COMMAND_SPEC, args);
	if (unknown.length)
		throw new Error(`Unknown tailnet flag: ${unknown.join(", ")}`);
	const positional = args.filter((arg) => !arg.startsWith("-"));
	if (positional.length > 1 || (positional[0] && positional[0] !== "status"))
		throw new Error("Run buncargo tailnet status [--json]");
	const coordinator = await readCoordinatorState(false);
	const connection =
		coordinator && matchesProcessIdentity(coordinator.pid, coordinator.identity)
			? coordinator.connection
			: undefined;
	const discovery = await discoverTailnet(
		connection
			? createTailscaleClient(connection.binary, connection.socket)
			: undefined,
	);
	const result = {
		...discovery,
		sharing: isCoordinatorReady(coordinator),
	};
	console.log(
		readBooleanFlag(args, flags.json)
			? JSON.stringify(result)
			: [
					"notice" in discovery ? discovery.notice : "Tailscale connected",
					coordinator?.message,
					...result.runs.map(
						(run) =>
							`${run.project} / ${run.branch ?? run.worktree ?? "Main"} (${run.hostname})\n${run.targets.map((t) => `  ${t.name}: ${t.url}`).join("\n")}`,
					),
				]
					.filter(Boolean)
					.join("\n"),
	);
}
