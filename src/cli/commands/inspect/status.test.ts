import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getDaemonConfigPath } from "../../../core/hosts/paths";
import { HEALTH_PATH } from "../../../core/hosts/proxy";
import { CI_ENV_VARS } from "../../../core/runtime-flags";

const cli = resolve(import.meta.dir, "../../bin.ts");
let dir: string;
let served: string[] = [];
let daemon: ReturnType<typeof Bun.serve>;

/**
 * A hosts daemon answering health for whatever `served` lists, on a port of
 * its own: the CLI reads the port from the isolated HOME's daemon config.
 */
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-status-")));
	daemon = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === HEALTH_PATH
				? Response.json({
						ok: true,
						routes: served.length,
						hostnames: served,
						lastReloadAt: Date.now(),
					})
				: new Response("not found", { status: 404 }),
	});
	const home = join(dir, "home");
	const configPath = getDaemonConfigPath(home);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({ httpsPort: daemon.port, httpPort: 0, tls: false }),
	);
	writeFileSync(
		join(dir, "dev.config.ts"),
		`export default { projectPrefix: "statusjson", services: {}, apps: { web: { port: 5173, devCommand: "true" } }, options: { hosts: true } };`,
	);
});
afterEach(() => {
	daemon.stop(true);
	served = [];
	rmSync(dir, { recursive: true, force: true });
});

interface StatusJson {
	urls: Record<string, string>;
	hosts: { active: boolean; plan: { hostname: string }[] } | null;
}

/** `buncargo status --json` without blocking the daemon this process serves. */
async function status(): Promise<StatusJson> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: join(dir, "home"),
	};
	for (const name of CI_ENV_VARS) delete env[name];
	delete env.BUNCARGO_HOSTS;
	const proc = Bun.spawn([process.execPath, cli, "status", "--json"], {
		cwd: dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`status exited ${code}: ${stderr}`);
	return JSON.parse(stdout) as StatusJson;
}

it("reports named hosts as the daemon serves them, with their URLs", async () => {
	const before = await status();
	expect(before.hosts?.active).toBe(false);
	expect(before.urls.web).toMatch(/^http:\/\/localhost:\d+$/);

	served = before.hosts?.plan.map((entry) => entry.hostname) ?? [];
	expect(served.length).toBeGreaterThan(0);
	const after = await status();
	expect(after.hosts?.active).toBe(true);
	expect(after.urls.web).toStartWith("https://");
	expect(served.some((hostname) => after.urls.web?.includes(hostname))).toBe(
		true,
	);
}, 30_000);
