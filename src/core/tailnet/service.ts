import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stateFilePath } from "../state-paths";
import {
	createTailscaleClient,
	mappingState,
	serveState,
	tailnetStatus,
} from "./client";
import { createTailnetRuntime } from "./runtime";
import { DIRECTORY_LOCAL_PORT, DIRECTORY_PORT, mutateTailnet } from "./state";

const exec = promisify(execFile);
const LABEL = "dev.buncargo.tailnet";

// ── Service manifest helpers ─────────────────────────────────────────────────

const xml = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const unitQuote = (s: string) =>
	`"${s.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function tailnetServiceDefinition(input: {
	platform: string;
	bun: string;
	script: string;
	home: string;
	log: string;
	binary: string;
}) {
	if (input.platform === "darwin") {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
	<dict>
		<key>Label</key>
		<string>${LABEL}</string>
		<key>ProgramArguments</key>
		<array>
			<string>${xml(input.bun)}</string>
			<string>${xml(input.script)}</string>
		</array>
		<key>EnvironmentVariables</key>
		<dict>
			<key>HOME</key>
			<string>${xml(input.home)}</string>
			<key>BUNCARGO_TAILSCALE_PATH</key>
			<string>${xml(input.binary)}</string>
		</dict>
		<key>RunAtLoad</key>
		<true/>
		<key>KeepAlive</key>
		<true/>
		<key>StandardOutPath</key>
		<string>${xml(input.log)}</string>
		<key>StandardErrorPath</key>
		<string>${xml(input.log)}</string>
	</dict>
</plist>
`;
	}

	return `[Unit]
Description=Buncargo tailnet directory and cleanup
After=network-online.target

[Service]
ExecStart=${unitQuote(input.bun)} ${unitQuote(input.script)}
Environment=${unitQuote(`HOME=${input.home}`)} ${unitQuote(`BUNCARGO_TAILSCALE_PATH=${input.binary}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function servicePath() {
	return process.platform === "darwin"
		? join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`)
		: join(homedir(), ".config/systemd/user", `${LABEL}.service`);
}

// ── Health ───────────────────────────────────────────────────────────────────

export async function tailnetDaemonHealthy(): Promise<boolean> {
	try {
		const response = await fetch(
			`http://127.0.0.1:${DIRECTORY_LOCAL_PORT}/health`,
			{ signal: AbortSignal.timeout(1000) },
		);
		const value: unknown = await response.json();

		return (
			response.ok &&
			typeof value === "object" &&
			value !== null &&
			"service" in value &&
			value.service === "buncargo-tailnet"
		);
	} catch {
		return false;
	}
}

// ── User service lifecycle ─────────────────────────────────────────────────

async function command(program: string, args: string[]) {
	await exec(program, args, { timeout: 15000 });
}

async function stopService() {
	const path = servicePath();
	if (!existsSync(path)) return;

	if (process.platform === "darwin") {
		try {
			await command("launchctl", [
				"bootout",
				`gui/${process.getuid?.()}`,
				path,
			]);
		} catch {
			/* May already be unloaded. */
		}
	} else {
		await command("systemctl", [
			"--user",
			"disable",
			"--now",
			`${LABEL}.service`,
		]);
	}
}

async function installAgent(binary: string) {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error(
			"Tailnet installation supports macOS and Linux (use WSL on Windows)",
		);
	}

	// Walk up from this module to the buncargo package root.
	let root = dirname(fileURLToPath(import.meta.url));

	while (dirname(root) !== root) {
		try {
			const manifest = JSON.parse(
				await readFile(join(root, "package.json"), "utf8"),
			);

			if (manifest.name === "buncargo") break;
		} catch {
			/* Look in the package ancestor. */
		}

		root = dirname(root);
	}

	const bundle = join(root, "dist/tailnetd.js");

	if (!existsSync(bundle)) {
		throw new Error(
			"Missing tailnet daemon bundle. Run bun run build in buncargo or reinstall the package.",
		);
	}

	const script = stateFilePath("bin/tailnetd.js");
	await mkdir(dirname(script), { recursive: true });
	await stopService();
	await copyFile(bundle, script);

	const path = servicePath();
	await mkdir(dirname(path), { recursive: true });

	await writeFile(
		path,
		tailnetServiceDefinition({
			platform: process.platform,
			bun: process.execPath,
			script,
			home: homedir(),
			log: stateFilePath("tailnet.log"),
			binary,
		}),
		{ mode: 0o600 },
	);

	try {
		if (process.platform === "darwin") {
			await command("launchctl", [
				"bootstrap",
				`gui/${process.getuid?.()}`,
				path,
			]);
		} else {
			await command("systemctl", ["--user", "daemon-reload"]);
			await command("systemctl", [
				"--user",
				"enable",
				"--now",
				`${LABEL}.service`,
			]);
		}

		for (let i = 0; i < 20; i++) {
			if (await tailnetDaemonHealthy()) return;

			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		throw new Error(
			`Tailnet coordinator did not start; inspect ${stateFilePath("tailnet.log")} or the user service journal. Linux needs an active systemd user manager; enable lingering for operation after logout.`,
		);
	} catch (error) {
		await stopService();
		await rm(path, { force: true });
		throw error;
	}
}

// ── Install / uninstall ──────────────────────────────────────────────────────

export async function installTailnet(discoveryPort = DIRECTORY_PORT) {
	if (
		!Number.isInteger(discoveryPort) ||
		discoveryPort < 40000 ||
		discoveryPort > 49999 ||
		discoveryPort === DIRECTORY_LOCAL_PORT
	) {
		throw new Error("Discovery port must be 40000–49999 excluding 48444");
	}

	const { tailscaleBinary } = await import("./client");

	// Resolve PATH now; launchd/systemd do not inherit the interactive shell PATH.
	const selected = tailscaleBinary();
	const binary = selected.includes("/") ? selected : Bun.which(selected);

	if (!binary) {
		throw new Error(
			"Install and connect Tailscale, then rerun buncargo tailnet install",
		);
	}

	const ts = createTailscaleClient(binary);
	const { self } = await tailnetStatus(ts);
	const target = `http://127.0.0.1:${DIRECTORY_LOCAL_PORT}`;

	// Start the loopback endpoint before touching Serve. This proves CLI/bundle
	// installation locally even if the tailnet still needs HTTPS authorization.
	await installAgent(binary);

	try {
		await mutateTailnet(async (state, save) => {
			const actual = await serveState(ts);
			const disposition = mappingState(
				actual,
				self.hostname,
				discoveryPort,
				target,
			);

			if (
				disposition === "conflict" ||
				(disposition === "owned" && state.directory?.hostname !== self.hostname)
			) {
				throw new Error(
					`Discovery port ${discoveryPort} is already owned by another Serve configuration`,
				);
			}

			if (state.directory && state.directory.hostname !== self.hostname) {
				throw new Error(
					"The machine DNS name changed. Uninstall the old buncargo tailnet mappings before reinstalling.",
				);
			}

			if (
				state.directory &&
				(state.directory.port ?? DIRECTORY_PORT) !== discoveryPort
			) {
				throw new Error(
					"Uninstall the existing buncargo tailnet directory before changing its port",
				);
			}

			state.directory = {
				hostname: self.hostname,
				target,
				port: discoveryPort,
			};
			await save();

			await ts(["serve", "--bg", "--yes", `--https=${discoveryPort}`, target]);

			if (
				mappingState(
					await serveState(ts),
					self.hostname,
					discoveryPort,
					target,
				) !== "owned"
			) {
				throw new Error(
					"Enable HTTPS in the Tailscale admin console, then rerun buncargo tailnet install",
				);
			}

			state.enabled = true;
			await save();
		});
	} catch (error) {
		// Leave the coordinator available to diagnose/retry and retain the ownership
		// journal if Serve timed out after applying the mapping.
		throw new Error(
			`${String(error)}\nRun buncargo tailnet install again after completing any Tailscale HTTPS authorization. Tailnet mode has not been newly enabled.`,
		);
	}

	return `https://${self.hostname}:${discoveryPort}`;
}

export async function uninstallTailnet() {
	const runtime = createTailnetRuntime();

	await mutateTailnet(async (state, save) => {
		state.enabled = false;
		await save();
		await runtime.clear(state, save);

		if (state.directory) {
			const d = state.directory;
			const disposition = mappingState(
				await serveState(runtime.command),
				d.hostname,
				d.port ?? DIRECTORY_PORT,
				d.target,
			);

			if (disposition === "conflict") {
				throw new Error(
					`Discovery port ${d.port ?? DIRECTORY_PORT} was changed outside buncargo; refusing to remove it`,
				);
			}

			if (disposition === "owned") {
				await runtime.command([
					"serve",
					"--bg",
					`--https=${d.port ?? DIRECTORY_PORT}`,
					"off",
				]);
			}

			delete state.directory;
			await save();
		}
	});

	await stopService();
	await rm(servicePath(), { force: true });

	if (process.platform === "linux") {
		await command("systemctl", ["--user", "daemon-reload"]);
	}
}
