import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment } from "./create-dev-environment";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "buncargo-app-only-"));
	roots.push(root);
	const env = createDevEnvironment(
		{
			projectPrefix: "marketing",
			services: { postgres: { port: 5432 } },
			apps: {
				marketing: {
					port: 3333,
					devCommand: `${process.execPath} -e 'Bun.serve({port:Number(process.env.PORT),fetch:()=>new Response("ok")})'`,
					healthEndpoint: "/",
				},
				api: { port: 3000, devCommand: false, requiredServices: ["postgres"] },
			},
			prisma: { generate: "exit 99" },
			migrations: [{ name: "unrelated", command: "exit 99" }],
			seed: { command: "exit 99" },
			hooks: {
				afterContainersReady: async () => {
					throw new Error("unrelated hook");
				},
			},
			options: { verbose: false },
		},
		{ root, containerRuntime: "runtime-lookup-must-not-run" },
	);
	Object.defineProperty(env, "containerRuntime", {
		get: () => {
			throw new Error("runtime accessed");
		},
	});
	return { root, env };
}

it("starts an HTTP app without containers or database preparation", async () => {
	const { root, env } = fixture();
	const controller = new AbortController();
	const pids = await env.start({
		onlyApps: ["marketing"],
		signal: controller.signal,
		productionBuild: false,
	});
	try {
		expect(await (await fetch(env.urls.marketing)).text()).toBe("ok");
		expect(existsSync(join(root, env.composeFile))).toBe(false);
		await env.stop();
		await expect(fetch(env.urls.marketing)).rejects.toThrow();
	} finally {
		for (const pid of Object.values(pids ?? {})) await env.stopProcess(pid);
	}
});

it("rejects invalid selection before persisting allocation", async () => {
	const { root, env } = fixture();
	await expect(
		env.start({ onlyApps: ["missing" as "marketing"] }),
	).rejects.toThrow("Unknown app");
	expect(existsSync(join(root, ".buncargo/ports.json"))).toBe(false);
});
