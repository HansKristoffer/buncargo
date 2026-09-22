import { spawnSync } from "node:child_process";
import { readCoordinatorState } from "../../core/connect/coordinator-state";
import { ensureReceiver, receiverToken } from "../../core/connect/identity";
import { ensureConnectCoordinator } from "../../core/connect/launcher";
import { type Directory, parseDirectory } from "../../core/connect/protocol";
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
	usage: "buncargo connect <token|status|open|revoke> [id] [--json]",
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
		{
			command: "BUNCARGO_CONNECT_RELAYS",
			description:
				"Optional relay URLs to use instead of the free public ones, on both ends.",
		},
	],
};

/** The coordinator holds the connections, so every action on one goes through it. */
async function coordinator<T>(path: string, body?: unknown): Promise<T> {
	await ensureConnectCoordinator();
	const state = await readCoordinatorState();
	if (!state?.connection) {
		throw new Error("Connection coordinator unavailable");
	}
	const response = await fetch(
		`http://127.0.0.1:${state.connection.port}${path}`,
		{
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			signal: AbortSignal.timeout(10000),
			headers: {
				authorization: `Bearer ${state.connection.token}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		},
	);
	const value = await response.json();
	if (!response.ok) {
		throw new Error(
			typeof (value as { error?: unknown })?.error === "string"
				? (value as { error: string }).error
				: "Connection failed",
		);
	}
	return value as T;
}

async function connectionStatus(): Promise<Directory> {
	return parseDirectory(await coordinator("/status"));
}

function formatDirectory(directory: Directory): string {
	const runs = directory.runs.map((run) => {
		const name = `${run.name} / ${run.project} / ${run.branch ?? run.worktree ?? "Main"}`;
		const targets = run.targets.map(
			(target) => `  ${target.name}: ${target.url}`,
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
		!["token", "status", "open", "revoke"].includes(command) ||
		(["token", "status"].includes(command) ? !!id : !id) ||
		(readBooleanFlag(args, flags.rotate) && command !== "token")
	) {
		throw new Error(CONNECT_COMMAND_SPEC.usage);
	}
	const json = readBooleanFlag(args, flags.json);
	let result: unknown;
	if (command === "token") {
		const token = receiverToken(
			await ensureReceiver(readBooleanFlag(args, flags.rotate)),
		);
		result = json ? { token } : token;
	} else if (command === "status") {
		const directory = await connectionStatus();
		result = json ? directory : formatDirectory(directory);
	} else if (command === "revoke") {
		result = await coordinator("/revoke", { id });
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
