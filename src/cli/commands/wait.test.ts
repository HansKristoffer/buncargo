import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRunEntry, patchRun, publishRun } from "../../core/run-registry";

const cli = resolve(import.meta.dir, "../bin.ts");
let home: string;
let root: string;
let savedHome: string | undefined;

beforeEach(async () => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-wait-home-")));
	root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-wait-root-")));
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	savedHome = process.env.HOME;
	process.env.HOME = home;
	// This test process stands in for the `dev` run, so the entry is live.
	await publishRun({
		...buildRunEntry({
			sessionId: "wait-session",
			projectPrefix: "shop",
			projectName: "shop",
			root,
			isWorktree: false,
		}),
		apps: [
			{
				name: "platform",
				port: 5173,
				url: "http://localhost:5173",
				loopbackUrl: "http://localhost:5173",
				status: "starting",
			},
		],
	});
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

function wait(...args: string[]) {
	return Bun.spawn([process.execPath, cli, "wait", ...args], {
		cwd: root,
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
}

it("returns once the app is healthy", async () => {
	const child = wait("--app=platform", "--timeout=10");
	await Bun.sleep(300);
	await patchRun("wait-session", {
		apps: [{ name: "platform", status: "ready" }],
	});
	expect(await child.exited).toBe(0);
});

it("holds until the app stops", async () => {
	await patchRun("wait-session", {
		apps: [{ name: "platform", status: "ready" }],
	});
	const child = wait("--app=platform", "--hold");
	await Bun.sleep(1500);
	expect(child.exitCode).toBeNull();
	await patchRun("wait-session", {
		apps: [{ name: "platform", status: "stopped" }],
	});
	expect(await child.exited).toBe(0);
}, 10_000);

it("times out, naming a missing app", async () => {
	const child = wait("--app=nope", "--timeout=1");
	expect(await child.exited).toBe(2);
	expect(await new Response(child.stderr).text()).toContain(
		"has an app named nope",
	);
});
