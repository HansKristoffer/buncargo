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
	type AnyCommand,
	BASE_EXITS,
	defineCommand,
	defineGroup,
} from "../command-spec";

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

/** Strings as they are, anything else as one line of JSON. */
function print(result: unknown): number {
	console.log(typeof result === "string" ? result : JSON.stringify(result));
	return 0;
}

const JSON_FLAG = {
	json: { kind: "boolean", description: "Print JSON" },
} as const;

const TARGET_ARG = [
	{
		name: "<target-id>",
		description: "A target id from connect status --json",
		required: true,
	},
] as const;

const statusCommand = defineCommand({
	spec: {
		name: "connect status",
		summary: "The private services shared with this machine",
		flags: JSON_FLAG,
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
	},
	exits: BASE_EXITS,
	json: "Directory (--json)",
	run: async ({ values }) => {
		const directory = await connectionStatus();
		return print(values.json ? directory : formatDirectory(directory));
	},
});

/** The commands that act on one target and print the coordinator's JSON answer. */
function targetCommand(
	name: string,
	summary: string,
	act: (id: string) => Promise<unknown>,
): AnyCommand {
	return defineCommand({
		spec: { name: `connect ${name}`, summary, flags: {}, args: TARGET_ARG },
		exits: BASE_EXITS,
		run: async ({ positionals: [id] }) => print(await act(id)),
	});
}

export const connectCommand = defineGroup({
	spec: {
		name: "connect",
		summary: "Discover private services through frp",
	},
	subcommands: {
		token: defineCommand({
			spec: {
				name: "connect token",
				summary: "This machine's publish-only recipient token",
				flags: {
					...JSON_FLAG,
					rotate: {
						kind: "boolean",
						description: "Replace the publish-only recipient token",
					},
				},
			},
			exits: BASE_EXITS,
			run: async ({ values }) => {
				const receiver = await ensureReceiver(values.rotate);
				return print(values.json ? { token: receiver.token } : receiver.token);
			},
		}),
		status: statusCommand,
		open: targetCommand(
			"open",
			"Open an HTTP target in the browser",
			async (id) => {
				const directory = await connectionStatus();
				const target = directory.runs
					.flatMap((run) => run.targets)
					.find((target) => target.id === id && target.protocol === "http");
				if (!target) throw new Error("App is unavailable");
				if (!openUrl(target.url))
					throw new Error(`Open ${target.url} in your browser`);
				return { url: target.url };
			},
		),
		tcp: targetCommand(
			"tcp",
			"Connect to a TCP target; prints its local address as JSON",
			(id) => requestCoordinator<TCPConnection>("/tcp", { id }),
		),
		disconnect: targetCommand("disconnect", "Close a TCP connection", (id) =>
			requestCoordinator("/disconnect", { id }),
		),
		revoke: targetCommand(
			"revoke",
			"Stop sharing a target with this machine",
			async (id) => {
				const receiver = await requireReceiver();
				return request(
					receiver.origin,
					`/v1/receiver/grants/${encodeURIComponent(id)}`,
					receiver.owner,
					undefined,
					"DELETE",
				);
			},
		),
	},
	fallback: statusCommand,
});
