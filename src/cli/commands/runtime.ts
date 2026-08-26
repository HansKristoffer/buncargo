import { getCaPath, isHostsDaemonHealthy } from "../../core/hosts";
import { findMonorepoRoot } from "../../core/ports";
import { isHostsForcedOff } from "../../core/runtime-flags";
import { loadDevEnv } from "../../loader";
import { exitOnDevArgErrors, parseDevArgs, printDevHelp } from "../dev-flags";
import { getFlagValue } from "../flags";
import * as log from "../log";
import { runCli } from "../run-cli";
import { parseTypecheckArgs, printTypecheckHelp } from "../typecheck-flags";

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

export async function loadEnv(options: { containerRuntime?: string } = {}) {
	try {
		return await loadDevEnv(options);
	} catch (error) {
		log.fail(error instanceof Error ? error.message : String(error));
	}
}

export async function handleDev(args: string[]): Promise<void> {
	const parsed = parseDevArgs(args);
	// Help comes from the flag spec, so it must not require a config file.
	if (parsed.help) {
		printDevHelp();
		return;
	}
	exitOnDevArgErrors(parsed);
	// The runtime has to be known before the environment is built, so it is read
	// here rather than inside runCli, which is handed a finished env.
	const env = await loadEnv({ containerRuntime: parsed.runtime });
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
		loopbackUrls: env.loopbackUrls,
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

export async function handleTypecheck(args: string[] = []): Promise<void> {
	const parsed = parseTypecheckArgs(args);
	if (parsed.help) {
		printTypecheckHelp();
		return;
	}
	if (parsed.unknownFlags.length > 0) {
		log.fail(
			`Unknown flag${parsed.unknownFlags.length > 1 ? "s" : ""}: ${parsed.unknownFlags.join(", ")}`,
			['Run "bunx buncargo typecheck --help" for typecheck options.'],
		);
	}
	if (parsed.errors.length > 0) {
		log.fail(parsed.errors[0] ?? "Invalid typecheck arguments.");
	}

	const { runWorkspaceTypecheck } = await import("../../typecheck");
	const result = await runWorkspaceTypecheck({
		root: findMonorepoRoot(),
		verbose: true,
		concurrency: parsed.concurrency,
		only: parsed.only,
	});
	process.exit(result.success ? 0 : 1);
}
