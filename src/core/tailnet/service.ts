import { abortableSleep } from "../deadline";
import { withFileLock } from "../file-lock";
import { stateFilePath } from "../state-paths";
import { installTailnetAgent, removeTailnetAgent } from "./agent";
import {
	createTailscaleClient,
	mappingState,
	serveState,
	type TailscaleCommand,
	tailnetStatus,
	tailscaleBinary,
} from "./client";
import { createTailnetRuntime } from "./runtime";
import {
	DIRECTORY_LOCAL_PORT,
	DIRECTORY_PORT,
	mutateTailnet,
	type TailnetState,
} from "./state";

export { tailnetDaemonHealthy } from "./health";
export { tailnetServiceDefinition } from "./service-definition";

export function validateDirectoryInstall(
	state: TailnetState,
	actual: Record<string, unknown>,
	hostname: string,
	port: number,
) {
	if (state.removing)
		throw new Error(
			"Tailnet cleanup is pending. Rerun tailnet uninstall before installing.",
		);

	const disposition = mappingState(
		actual,
		hostname,
		port,
		`http://127.0.0.1:${DIRECTORY_LOCAL_PORT}`,
	);

	if (
		disposition === "conflict" ||
		(disposition === "owned" && state.directory?.hostname !== hostname)
	)
		throw new Error(
			`Discovery port ${port} is already owned by another Serve configuration`,
		);

	if (state.directory && state.directory.hostname !== hostname)
		throw new Error(
			"Machine DNS name changed. Uninstall the old tailnet directory before reinstalling.",
		);

	if (state.directory && (state.directory.port ?? DIRECTORY_PORT) !== port)
		throw new Error(
			"Uninstall the existing tailnet directory before changing its port",
		);
}

export async function verifyTailnetDirectory(
	endpoint: string,
	expectedID: string,
	request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
	const signal = AbortSignal.timeout(10000);

	// The agent answers health before its first successful directory refresh.
	for (;;) {
		signal.throwIfAborted();

		let response: Response;

		try {
			response = await request(`${endpoint}/v1/info`, {
				signal,
				redirect: "error",
			});
		} catch (error) {
			if (signal.aborted) throw error;

			await abortableSleep(250, signal);

			continue;
		}

		if (response.status === 503) {
			await response.body?.cancel();
			await abortableSleep(250, signal);

			continue;
		}

		const info = (await response.json()) as {
			version?: unknown;
			machineId?: unknown;
			hostname?: unknown;
		};

		if (
			!response.ok ||
			info.version !== 1 ||
			info.machineId !== expectedID ||
			info.hostname !== new URL(endpoint).hostname
		)
			throw new Error("HTTPS directory did not return this machine's identity");

		return;
	}
}

// Hold a separate lifecycle lock across service replacement without blocking coordinator state reads.
const serviceLock = <T>(operation: () => Promise<T>) =>
	withFileLock(stateFilePath("tailnet-install"), operation, {
		timeoutMs: 120000,
	});

const defaults = {
	command: () => {
		const selected = tailscaleBinary();
		const binary = selected.includes("/") ? selected : Bun.which(selected);

		if (!binary)
			throw new Error(
				"Install and connect Tailscale, then rerun buncargo tailnet install",
			);

		return { binary, ts: createTailscaleClient(binary) };
	},
	installAgent: installTailnetAgent,
	removeAgent: removeTailnetAgent,
	verify: verifyTailnetDirectory,
};

export async function installTailnet(
	discoveryPort = DIRECTORY_PORT,
	overrides: Partial<typeof defaults> = {},
) {
	if (
		!Number.isInteger(discoveryPort) ||
		discoveryPort < 40000 ||
		discoveryPort > 49999 ||
		discoveryPort === DIRECTORY_LOCAL_PORT
	)
		throw new Error("Discovery port must be 40000–49999 excluding 48444");

	const deps = { ...defaults, ...overrides };

	return serviceLock(async () => {
		const { binary, ts } = deps.command();
		const { self } = await tailnetStatus(ts);

		const check = async (state: TailnetState) =>
			validateDirectoryInstall(
				state,
				await serveState(ts),
				self.hostname,
				discoveryPort,
			);

		// Validate before disrupting a working coordinator; recheck under the mutation lock below.
		await mutateTailnet(async (state) => check(state));
		await deps.installAgent(binary);
		await mutateTailnet(async (state, save) => {
			await check(state);

			const target = `http://127.0.0.1:${DIRECTORY_LOCAL_PORT}`;

			// Journal ownership before invoking Serve so an interrupted install remains recoverable.
			state.directory = {
				hostname: self.hostname,
				target,
				port: discoveryPort,
			};
			await save();

			try {
				await ts([
					"serve",
					"--bg",
					"--yes",
					`--https=${discoveryPort}`,
					target,
				]);

				if (
					mappingState(
						await serveState(ts),
						self.hostname,
						discoveryPort,
						target,
					) !== "owned"
				)
					throw new Error(
						"Enable HTTPS in Tailscale, then rerun buncargo tailnet install",
					);

				state.enabled = true;
				await save();
			} catch (error) {
				throw new Error(
					`${String(error)}. Ownership is recorded for recovery; run tailnet doctor --repair or retry install.`,
				);
			}
		});

		const endpoint = `https://${self.hostname}:${discoveryPort}`;

		try {
			await deps.verify(endpoint, self.id);
		} catch (error) {
			throw new Error(
				`Tailnet configured, but HTTPS directory verification failed: ${String(error)}. Run tailnet doctor; verify access from another device before relying on remote URLs.`,
			);
		}

		return endpoint;
	});
}

export async function uninstallTailnet(
	overrides: {
		command?: TailscaleCommand;
		removeAgent?: () => Promise<void>;
	} = {},
) {
	return serviceLock(async () => {
		const runtime = createTailnetRuntime({ command: overrides.command });

		await mutateTailnet(async (state, save) => {
			// Persist removal intent first: recovery must finish cleanup instead of restoring mappings.
			state.enabled = false;
			state.removing = true;
			await save();

			try {
				await runtime.clear(state, save);
			} catch (error) {
				throw new Error(
					`${String(error)}. Sharing is disabled; the coordinator remains installed to retry cleanup. Rerun tailnet uninstall to finish removal.`,
				);
			}
		});

		// Keep the coordinator available until every owned mapping has been removed.
		await (overrides.removeAgent ?? removeTailnetAgent)();
		await mutateTailnet(async (state, save) => {
			delete state.removing;
			await save();
		});
	});
}
