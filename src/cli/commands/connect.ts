import { isOneOf, typedSwitch } from "hanzio";
import {
	ensureReceiver,
	request,
	requireReceiver,
} from "../../core/connect/client";
import { requestCoordinator } from "../../core/connect/launcher";
import {
	type Directory,
	parseDirectory,
	type TCPConnection,
} from "../../core/connect/protocol";
import { openUrl } from "../../core/open-url";
import { connectOrigin } from "../../core/runtime-flags";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
} from "../command-spec";
import { argumentsError } from "../errors";

const CONNECT_COMMANDS = [
	"token",
	"status",
	"open",
	"tcp",
	"disconnect",
	"revoke",
] as const;

const flags = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show connection help",
	},
	json: { name: "--json", kind: "boolean", description: "Print JSON" },
	rotate: {
		name: "--rotate",
		kind: "boolean",
		description: "Replace the publish-only recipient token",
	},
} as const;

export const CONNECT_COMMAND_SPEC: CommandSpec = {
	usage:
		"buncargo connect <token|status|open|tcp|disconnect|revoke> [target-id] [--json]",
	flags: Object.values(flags),
	notes: [
		{
			command: "BUNCARGO_CONNECT_TOKENS",
			description:
				"Comma-separated recipient tokens: dev automatically shares selected endpoints.",
		},
		{
			command: "BUNCARGO_CONNECT_NAME",
			description: "Optional remote environment group name in BuncargoBar.",
		},
	],
};

async function connectionStatus(): Promise<Directory> {
	return parseDirectory(await requestCoordinator("/status"), connectOrigin());
}

function formatDirectory(directory: Directory): string {
	const runs = directory.runs.map((run) => {
		const name = `${run.name} / ${run.project} / ${run.branch ?? run.worktree ?? "Main"}`;
		const targets = run.targets.map(
			(target) => `  ${target.name}: ${target.url || "private TCP"}`,
		);
		return [name, ...targets].join("\n");
	});
	return [directory.notice ?? "Connected", ...runs].join("\n");
}

export async function handleConnect(args: string[]) {
	if (readBooleanFlag(args, flags.help)) {
		console.log(formatCommandHelp(CONNECT_COMMAND_SPEC));
		return;
	}
	const unknown = findUnknownFlags(CONNECT_COMMAND_SPEC, args);
	if (unknown.length) {
		throw argumentsError(
			unknown.map((flag) => `Unknown flag: ${flag}`),
			"connect",
		);
	}
	const [command = "status", id, ...extra] = args.filter(
		(a) => !a.startsWith("-"),
	);
	if (
		extra.length ||
		!isOneOf(CONNECT_COMMANDS, command) ||
		(["token", "status"].includes(command) ? !!id : !id) ||
		(readBooleanFlag(args, flags.rotate) && command !== "token")
	) {
		throw argumentsError([`Usage: ${CONNECT_COMMAND_SPEC.usage}`], "connect");
	}
	const json = readBooleanFlag(args, flags.json);
	const result: unknown = await typedSwitch(command, {
		token: async () => {
			const receiver = await ensureReceiver(
				readBooleanFlag(args, flags.rotate),
			);
			return json ? { token: receiver.token } : receiver.token;
		},
		status: async () => {
			const directory = await connectionStatus();
			return json ? directory : formatDirectory(directory);
		},
		tcp: () => requestCoordinator<TCPConnection>("/tcp", { id }),
		disconnect: () => requestCoordinator("/disconnect", { id }),
		revoke: async () => {
			const receiver = await requireReceiver();
			return request(
				receiver.origin,
				`/v1/receiver/grants/${encodeURIComponent(id)}`,
				receiver.owner,
				undefined,
				"DELETE",
			);
		},
		open: async () => {
			const directory = await connectionStatus();
			const target = directory.runs
				.flatMap((run) => run.targets)
				.find((target) => target.id === id && target.protocol === "http");
			if (!target) {
				throw new Error("App is unavailable");
			}
			if (!openUrl(target.url)) {
				throw new Error(`Open ${target.url} in your browser`);
			}
			return { url: target.url };
		},
	});
	console.log(typeof result === "string" ? result : JSON.stringify(result));
}
