import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { abortableSleep } from "../deadline";
import { writeJsonDocument } from "../registry-file";
import { stateFilePath } from "../state-paths";
import { tailnetBundle } from "./bundle";
import { readTailnetHealth } from "./health";
import {
	TAILNET_SERVICE_LABEL as LABEL,
	tailnetServiceDefinition,
} from "./service-definition";

/** Transaction seam: preserve the previous definition and bundle until the new agent answers. */
export async function replaceTailnetAgent(
	definition: string,
	hash: string,
	deps: {
		read(): Promise<string | undefined>;
		write(value: string): Promise<void>;
		remove(): Promise<void>;
		stop(): Promise<void>;
		start(): Promise<void>;
		healthy(hash: string): Promise<boolean>;
		sleep(): Promise<void>;
	},
) {
	const previous = await deps.read();

	await deps.stop();

	try {
		await deps.write(definition);
		await deps.start();

		for (let i = 0; i < 20; i++) {
			if (await deps.healthy(hash)) return;

			await deps.sleep();
		}

		throw new Error(
			"Tailnet coordinator did not start; inspect tailnet.log or the systemd user journal",
		);
	} catch (error) {
		try {
			await deps.stop();

			// Restore the old definition on upgrades; remove the definition on failed first installs.
			if (previous !== undefined) {
				await deps.write(previous);
				await deps.start();
			} else await deps.remove();
		} catch (rollback) {
			throw new AggregateError(
				[error, rollback],
				`Agent replacement failed and rollback failed: ${String(error)}; ${String(rollback)}`,
			);
		}

		throw error;
	}
}

const exec = promisify(execFile);

async function command(program: string, args: string[]) {
	await exec(program, args, { timeout: 15000 });
}

function servicePath() {
	return process.platform === "darwin"
		? join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`)
		: join(homedir(), ".config/systemd/user", `${LABEL}.service`);
}

async function stop() {
	const path = servicePath();

	if (!existsSync(path)) return;

	if (process.platform === "darwin") {
		try {
			await command("launchctl", [
				"bootout",
				`gui/${process.getuid?.()}`,
				path,
			]);
		} catch (error) {
			// A failed bootout is harmless only if the service is actually unloaded.
			try {
				await command("launchctl", [
					"print",
					`gui/${process.getuid?.()}/${LABEL}`,
				]);
			} catch {
				return;
			}

			throw error;
		}
	} else
		await command("systemctl", [
			"--user",
			"disable",
			"--now",
			`${LABEL}.service`,
		]);
}

async function start() {
	if (process.platform === "darwin") {
		await command("launchctl", [
			"bootstrap",
			`gui/${process.getuid?.()}`,
			servicePath(),
		]);

		// An SSH install can reach a GUI domain in on-demand-only mode,
		// where RunAtLoad alone leaves the agent pending indefinitely.
		await command("launchctl", [
			"kickstart",
			`gui/${process.getuid?.()}/${LABEL}`,
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
}

export async function installTailnetAgent(binary: string) {
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new Error(
			"Tailnet installation supports macOS and Linux (use WSL on Windows)",
		);

	const bundle = await tailnetBundle();

	// Retain the previous bundle on disk so a failed upgrade can start it again.
	const script = stateFilePath(`bin/tailnetd-${bundle.hash}.js`);

	await mkdir(dirname(script), { recursive: true });
	await writeFile(script, bundle.contents, { mode: 0o600 });

	const path = servicePath();

	await mkdir(dirname(path), { recursive: true });

	const metadata = {
		version: bundle.version,
		hash: bundle.hash,
		script,
		bun: process.execPath,
		binary,
	};

	await replaceTailnetAgent(
		tailnetServiceDefinition({
			platform: process.platform,
			...metadata,
			home: homedir(),
			log: stateFilePath("tailnet.log"),
		}),
		bundle.hash,
		{
			read: async () => (existsSync(path) ? readFile(path, "utf8") : undefined),
			write: async (value) => {
				await writeFile(path, value, { mode: 0o600 });
			},
			remove: () => rm(path, { force: true }),
			stop,
			start,
			healthy: async (hash) => (await readTailnetHealth())?.bundleHash === hash,
			sleep: () => abortableSleep(250),
		},
	);

	// Commit installation metadata only after the replacement answers with the expected hash.
	await writeJsonDocument(stateFilePath("tailnet-service.json"), metadata);
}

export async function removeTailnetAgent() {
	await stop();
	await rm(servicePath(), { force: true });
	await rm(stateFilePath("tailnet-service.json"), { force: true });

	if (process.platform === "linux")
		await command("systemctl", ["--user", "daemon-reload"]);
}
