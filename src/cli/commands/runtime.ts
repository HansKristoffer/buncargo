import { loadDevEnv } from "../../loader";
import { runCli } from "../run-cli";

export async function loadEnv() {
	try {
		return await loadDevEnv();
	} catch (error) {
		console.error(`❌ ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}

export async function handleDev(args: string[]): Promise<void> {
	const env = await loadEnv();
	await runCli(env, { args });
}

export async function handlePrisma(args: string[]): Promise<void> {
	const env = await loadEnv();

	if (!env.prisma) {
		console.error("❌ Prisma is not configured in your dev config.");
		console.error("");
		console.error("   Add prisma to your config:");
		console.error("");
		console.error("   export default defineDevConfig({");
		console.error("     ...");
		console.error("     prisma: {");
		console.error("       cwd: 'packages/prisma'");
		console.error("     }");
		console.error("   })");
		process.exit(1);
	}

	const exitCode = await env.prisma.run(args);
	process.exit(exitCode);
}

export async function handleEnv(): Promise<void> {
	const env = await loadEnv();
	console.log(
		JSON.stringify(
			{
				projectName: env.projectName,
				ports: env.ports,
				urls: env.urls,
				portOffset: env.portOffset,
				isWorktree: env.isWorktree,
				localIp: env.localIp,
				root: env.root,
			},
			null,
			2,
		),
	);
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
