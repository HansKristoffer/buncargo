import { readLiveRuns } from "../core/run-registry";
import { isCI } from "../core/runtime-flags";
import { createTailnetRuntime } from "../core/tailnet/runtime";
import { tailnetDaemonHealthy } from "../core/tailnet/service";
import { readTailnetState } from "../core/tailnet/state";
import type { AppConfig } from "../types";
import * as log from "./log";

interface TailnetEnv {
	root: string;
	ports: object;
	setTailnetUrls?: (urls: Readonly<Record<string, string | undefined>>) => void;
}

export async function prepareTailnet(
	env: TailnetEnv,
	input: {
		requested: boolean | undefined;
		publicExpose: boolean;
		startApps: Record<string, AppConfig>;
		reusedApps: Record<string, AppConfig>;
		signal?: AbortSignal;
	},
) {
	const state = readTailnetState();
	const disabled =
		input.requested === false ||
		(isCI() && input.requested !== true) ||
		(input.requested !== true && !state.enabled) ||
		input.publicExpose;
	if (disabled && Object.keys(input.reusedApps).length) {
		const runs = await readLiveRuns();
		const remoteReused = runs.some(
			(run) =>
				run.root === env.root &&
				run.apps.some((app) => app.name in input.reusedApps && app.tailnetUrl),
		);
		if (remoteReused)
			throw new Error(
				"A reused app still has tailnet URLs. Stop the owning run and restart in the selected URL mode.",
			);
	}
	if (input.requested === false || (isCI() && input.requested !== true)) return;
	if (input.requested !== true && !state.enabled) return;
	if (input.publicExpose) {
		if (input.requested === true)
			throw new Error(
				"Choose --tailnet or --expose for a coherent web/API URL mode",
			);
		return; // Explicit public exposure takes precedence over the machine default.
	}
	if (!state.enabled || !(await tailnetDaemonHealthy())) {
		const message =
			"Tailnet coordinator unavailable. Run buncargo tailnet install.";
		if (input.requested === true || Object.keys(input.reusedApps).length)
			throw new Error(message);
		log.warn(`${message} Continuing with local URLs.`);
		return;
	}
	if (!env.setTailnetUrls)
		throw new Error(
			"This DevEnvironment does not support tailnet URLs; update buncargo",
		);
	const ports = env.ports as Record<string, number>;
	const apps = Object.entries({
		...input.startApps,
		...input.reusedApps,
	}).flatMap(([name, app]) => {
		if (!app.expose || app.interactive || app.needsPublicUrls) return []; // Metro needs independent transport verification.
		const port = ports[name];
		if (port === undefined) return [];
		return [{ name, port, reused: name in input.reusedApps }];
	});
	if (!apps.length) {
		if (input.requested === true)
			throw new Error(
				"No selected HTTP apps have expose: true (interactive/Metro apps are not yet supported)",
			);
		return;
	}
	const runtime = createTailnetRuntime();
	const urls = await runtime.acquire({
		root: env.root,
		apps,
		signal: input.signal,
	});
	env.setTailnetUrls(urls);
	log.info("Private Tailscale URLs:");
	for (const [name, url] of Object.entries(urls)) log.info(`  ${name}: ${url}`);
}

export async function releaseTailnet(root: string, app?: string) {
	// The disabled path does not create a registry or require Tailscale.
	const state = readTailnetState();
	if (
		!state.allocations.some(
			(a) =>
				a.lease?.root === root &&
				a.lease.pid === process.pid &&
				(!app || a.lease.app === app),
		)
	)
		return;
	await createTailnetRuntime().release(root, process.pid, app);
}
