import { spawnSync } from "node:child_process";
import {
	ensureReceiver,
	request,
	requireReceiver,
} from "../../core/connect/client";
import { readCoordinatorState } from "../../core/connect/coordinator-state";
import { ensureConnectCoordinator } from "../../core/connect/launcher";
import {
	type Directory,
	parseDirectory,
	type TCPConnection,
} from "../../core/connect/protocol";
import { connectOrigin } from "../../core/runtime-flags";
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

async function coordinator<T>(path: string, body?: unknown): Promise<T> {
	await ensureConnectCoordinator();
	const state = await readCoordinatorState();
	if (!state?.connection) {
		throw new Error("Connection coordinator unavailable");
	}
	return request(
		`http://127.0.0.1:${state.connection.port}`,
		path,
		state.connection.token,
		body,
	);
}

async function connectionStatus(): Promise<Directory> {
	return parseDirectory(await coordinator("/status"), connectOrigin());
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
		throw new Error(`Unknown connect flag: ${unknown.join(", ")}`);
	}
	const [command = "status", id, ...extra] = args.filter(
		(a) => !a.startsWith("-"),
	);
	if (
		extra.length ||
		!["token", "status", "open", "tcp", "disconnect", "revoke"].includes(
			command,
		) ||
		(["token", "status"].includes(command) ? !!id : !id) ||
		(readBooleanFlag(args, flags.rotate) && command !== "token")
	) {
		throw new Error(CONNECT_COMMAND_SPEC.usage);
	}
	const json = readBooleanFlag(args, flags.json);
	let result: unknown;
	if (command === "token") {
		const receiver = await ensureReceiver(readBooleanFlag(args, flags.rotate));
		result = json ? { token: receiver.token } : receiver.token;
	} else if (command === "status") {
		const directory = await connectionStatus();
		result = json ? directory : formatDirectory(directory);
	} else if (command === "tcp") {
		result = await coordinator<TCPConnection>("/tcp", { id });
	} else if (command === "disconnect") {
		result = await coordinator("/disconnect", { id });
	} else if (command === "revoke") {
		const receiver = await requireReceiver();
		result = await request(
			receiver.origin,
			`/v1/receiver/grants/${encodeURIComponent(id)}`,
			receiver.owner,
			undefined,
			"DELETE",
		);
	} else {
		const directory = await connectionStatus();
		const target = directory.runs
			.flatMap((run) => run.targets)
			.find((target) => target.id === id && target.protocol === "http");
		if (!target) {
			throw new Error("App is unavailable");
		}
		const opened = spawnSync(
			process.platform === "darwin" ? "open" : "xdg-open",
			[target.url],
			{ stdio: "ignore" },
		);
		if (opened.status !== 0) {
			throw new Error(`Open ${target.url} in your browser`);
		}
		result = { url: target.url };
	}
	console.log(typeof result === "string" ? result : JSON.stringify(result));
}
