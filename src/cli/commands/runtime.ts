import { getCaPath, isHostsDaemonHealthy } from "../../core/hosts";
import { isHostsForcedOff } from "../../core/runtime-flags";
import { loadDevEnv } from "../../loader";
import { parseDevArgs, printDevHelp } from "../dev-flags";
import { getFlagValue } from "../flags";
import * as log from "../log";
import { runCli } from "../run-cli";

export function getEnvDotPath(
	snapshot: Record<string, unknown>,
	path: string,
): unknown {
	let current: unknown = snapshot;
	for (const part of path.split(".").filter(Boolean)) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export function formatEnvDotValue(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value);
}

export async function loadEnv() {
	try {
		return await loadDevEnv();
	} catch (error) {
		log.fail(error instanceof Error ? error.message : String(error));
	}
}

export async function handleDev(args: string[]): Promise<void> {
	// Help comes from the flag spec, so it must not require a config file.
	if (parseDevArgs(args).help) {
		printDevHelp();
		return;
	}
	const env = await loadEnv();
	await runCli(env, { args });
}

export async function handlePrisma(args: string[]): Promise<void> {
	const env = await loadEnv();

	if (!env.prisma) {
		log.fail("Prisma is not configured in your dev config.", [
			"Add prisma to your config:",
			"",
			"export default defineDevConfig({",
			"  ...",
			"  prisma: { cwd: 'packages/prisma' }",
			"})",
		]);
	}

	const exitCode = await env.prisma.run(args);
	process.exit(exitCode);
}

export async function handleEnv(args: string[] = []): Promise<void> {
	const env = await loadEnv();
	if (env.hosts && !isHostsForcedOff() && (await isHostsDaemonHealthy())) {
		env.setNamedHostsActive(true, { caPath: getCaPath() });
	}
	const snapshot = {
		projectName: env.projectName,
		ports: env.ports,
		urls: env.urls,
		portOffset: env.portOffset,
		portOffsetProvenance: env.portOffsetProvenance,
		isWorktree: env.isWorktree,
		localIp: env.localIp,
		root: env.root,
		hosts: env.hosts
			? {
					active: env.hosts.active,
					tld: env.hosts.tld,
					plan: env.hosts.plan,
				}
			: null,
	};
	const getPath = getFlagValue(args, "--get");
	if (getPath !== undefined) {
		if (getPath === "") {
			log.fail("Flag --get requires a dot path (e.g. ports.api).");
		}
		const value = getEnvDotPath(snapshot as Record<string, unknown>, getPath);
		if (value === undefined) {
			log.fail(`Unknown env path: ${getPath}`);
		}
		log.line(formatEnvDotValue(value));
		return;
	}
	log.line(JSON.stringify(snapshot, null, 2));
}

export async function handleTypecheck(): Promise<void> {
	const env = await loadEnv();
	const { runWorkspaceTypecheck } = await import("../../typecheck");
	const result = await runWorkspaceTypecheck({
		root: env.root,
		verbose: true,
	});
	process.exit(result.success ? 0 : 1);
}
