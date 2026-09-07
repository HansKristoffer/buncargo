import { matchesProcessIdentity } from "../../core/process-identity";
import {
	createTailscaleClient,
	mappingState,
	serveState,
} from "../../core/tailnet/client";
import { tailnetDiagnostics } from "../../core/tailnet/diagnostics";
import { discoverTailnetPeers } from "../../core/tailnet/peers";
import { createTailnetRuntime } from "../../core/tailnet/runtime";
import { installTailnet, uninstallTailnet } from "../../core/tailnet/service";
import { mutateTailnet, readTailnetState } from "../../core/tailnet/state";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readStringFlag,
} from "../command-spec";
import { TAILNET_SUBCOMMANDS } from "./registry";

const portFlag = {
	name: "--port",
	kind: "string",
	valueHint: "=N",
	description: "Stopped allocation to release",
	validate: (v: string) =>
		/^\d+$/.test(v) && Number(v) >= 20000 && Number(v) <= 29999
			? undefined
			: "--port must be between 20000 and 29999",
} as const;
const discoveryFlag = {
	name: "--discovery-port",
	kind: "string",
	valueHint: "=N",
	description: "Directory HTTPS port (default 48443)",
	validate: (v: string) =>
		/^\d+$/.test(v) &&
		Number(v) >= 40000 &&
		Number(v) <= 49999 &&
		Number(v) !== 48444
			? undefined
			: "--discovery-port must be 40000–49999 excluding 48444",
} as const;
const spec: CommandSpec = {
	usage: `buncargo tailnet <${TAILNET_SUBCOMMANDS.map((s) => s.name).join("|")}>`,
	flags: [
		portFlag,
		discoveryFlag,
		{
			name: "--repair",
			kind: "boolean",
			description: "Reconcile owned mappings (doctor only)",
		},
		{ name: "--json", kind: "boolean", description: "Machine-readable output" },
		{ name: "--help", kind: "boolean", description: "Show help" },
	],
	notes: TAILNET_SUBCOMMANDS.map((s) => ({
		command: s.name,
		description: s.summary,
	})),
};

export async function handleTailnet(args: string[]) {
	if (!args.length || args.includes("--help")) {
		console.log(formatCommandHelp(spec));
		return;
	}
	const [subcommand, ...flags] = args;
	const errors: string[] = [];
	const port = readStringFlag(flags, portFlag, errors);
	const discovery = readStringFlag(flags, discoveryFlag, errors);
	if (discovery !== undefined && subcommand !== "install")
		errors.push("--discovery-port is only valid with install");
	if (port !== undefined && subcommand !== "release")
		errors.push("--port is only valid with release");
	if (flags.includes("--repair") && subcommand !== "doctor")
		errors.push("--repair is only valid with doctor");
	const unknown = findUnknownFlags(spec, flags);
	if (unknown.length || errors.length)
		throw new Error(
			[...errors, ...unknown.map((s) => `Unknown flag: ${s}`)].join("\n"),
		);
	if (flags.some((s) => !s.startsWith("--")))
		throw new Error("Unexpected argument; use --port=N");
	switch (subcommand) {
		case "install": {
			const directory = await installTailnet(
				discovery ? Number(discovery) : readTailnetState().directory?.port,
			);

			console.log(
				`Tailnet enabled; HTTPS directory verified from this machine. Verify access from your other device. Directory: ${directory}`,
			);
			console.log(
				"Run buncargo dev in your main checkout or any worktree to share its apps privately. Use --tailnet to require sharing instead of falling back to local URLs.",
			);
			return;
		}
		case "uninstall":
			await uninstallTailnet();
			console.log(
				"Buncargo tailnet disabled; owned mappings removed. Port reservations retained.",
			);
			return;
		case "peers": {
			const peers = await discoverTailnetPeers();
			console.log(
				flags.includes("--json")
					? JSON.stringify(peers)
					: peers.map((p) => p.hostname).join("\n") ||
							"No reachable buncargo peers",
			);
			return;
		}
		case "status":
		case "doctor": {
			const command = createTailscaleClient();
			const repairs: string[] = [];
			if (flags.includes("--repair")) {
				try {
					repairs.push(
						...(
							await createTailnetRuntime({ command }).reconcile(
								AbortSignal.timeout(15000),
							)
						).issues,
					);
				} catch (error) {
					repairs.push(String(error));
				}
			}
			const result = await tailnetDiagnostics(command);
			result.issues.push(...repairs);
			console.log(
				flags.includes("--json")
					? JSON.stringify(result)
					: [
							`Tailnet: ${result.enabled === null ? "state unreadable" : result.enabled ? "enabled" : "disabled"}`,
							`Machine: ${result.hostname ?? "Tailscale unavailable"}`,
							`Coordinator: ${!result.coordinator ? "not running" : result.coordinator.ready ? "ready" : "running, remote access unavailable"}`,
							`Last successful reconciliation: ${result.coordinator?.lastSuccess ?? "unknown"}`,
							`Active mappings: ${result.allocations.filter((a) => a.active).length}; reserved app ports: ${result.allocations.length}`,
							...result.issues,
						].join("\n"),
			);
			return;
		}
		case "release": {
			if (!port)
				throw new Error(
					"Use buncargo tailnet release --port=N while the app is stopped",
				);
			await mutateTailnet(async (state, save) => {
				const a = state.allocations.find((a) => a.port === Number(port));
				if (!a) throw new Error("No buncargo allocation at that port");
				if (a.lease && matchesProcessIdentity(a.lease.pid, a.lease.identity))
					throw new Error("Stop the owning dev run before releasing its port");
				// Explicit reassignment abandons the old reservation without mutating a
				// possibly foreign Serve mapping. A subsequent allocation avoids it.
				if (a.lease) {
					const ts = createTailscaleClient();
					if (
						mappingState(
							await serveState(ts),
							a.lease.hostname,
							a.port,
							`http://127.0.0.1:${a.lease.upstream}`,
						) === "owned"
					) {
						await ts(["serve", "--bg", `--https=${a.port}`, "off"]);
					}
				}
				state.allocations = state.allocations.filter((v) => v !== a);
				await save();
			});
			console.log("Port reservation released");
			return;
		}
		default:
			throw new Error(`Unknown tailnet subcommand: ${subcommand}`);
	}
}
