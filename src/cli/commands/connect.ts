import { spawnSync } from "node:child_process";
import {
	ensureReceiver,
	readReceiver,
	request,
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
	if (!state?.connection) throw new Error("Connection coordinator unavailable");
	return request(
		`http://127.0.0.1:${state.connection.port}`,
		path,
		state.connection.token,
		body,
	);
}
export async function handleConnect(args: string[]) {
	if (readBooleanFlag(args, flags.help)) {
		console.log(formatCommandHelp(CONNECT_COMMAND_SPEC));
		return;
	}
	const unknown = findUnknownFlags(CONNECT_COMMAND_SPEC, args);
	if (unknown.length)
		throw new Error(`Unknown connect flag: ${unknown.join(", ")}`);
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
	)
		throw new Error(CONNECT_COMMAND_SPEC.usage);
	const json = readBooleanFlag(args, flags.json);
	let result: unknown;
	if (command === "token") {
		const r = await ensureReceiver(readBooleanFlag(args, flags.rotate));
		result = json ? { token: r.token } : r.token;
	} else if (command === "status") {
		const d = await coordinator<Directory>("/status");
		parseDirectory(d, connectOrigin());
		result = json
			? d
			: [
					d.notice ?? "Connected",
					...d.runs.map(
						(r) =>
							`${r.name} / ${r.project} / ${r.branch ?? r.worktree ?? "Main"}\n${r.targets.map((t) => `  ${t.name}: ${t.url || "private TCP"}`).join("\n")}`,
					),
				].join("\n");
	} else if (command === "tcp")
		result = await coordinator<TCPConnection>("/tcp", { id });
	else if (command === "disconnect")
		result = await coordinator("/disconnect", { id });
	else if (command === "revoke") {
		const r = await readReceiver();
		if (!r) throw new Error("Run buncargo connect token first");
		result = await request(
			r.origin,
			`/v1/receiver/grants/${encodeURIComponent(id)}`,
			r.owner,
			undefined,
			"DELETE",
		);
	} else {
		const d = parseDirectory(await coordinator("/status"), connectOrigin());
		const t = d.runs
			.flatMap((r) => r.targets)
			.find((t) => t.id === id && t.protocol === "http");
		if (!t) throw new Error("App is unavailable");
		const opened = spawnSync(
			process.platform === "darwin" ? "open" : "xdg-open",
			[t.url],
			{ stdio: "ignore" },
		);
		if (opened.status !== 0) throw new Error(`Open ${t.url} in your browser`);
		result = { url: t.url };
	}
	console.log(typeof result === "string" ? result : JSON.stringify(result));
}
