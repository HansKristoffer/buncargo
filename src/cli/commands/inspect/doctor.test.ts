import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CI_ENV_VARS } from "../../../core/runtime-flags";

const cli = resolve(import.meta.dir, "../../bin.ts");
let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-doctor-")));
	writeFileSync(
		join(dir, "dev.config.ts"),
		`export default { projectPrefix: "doctorhosts", services: {}, apps: { web: { port: 5173, devCommand: "true" } }, options: { hosts: true } };`,
	);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** `buncargo doctor`'s report, under the test run's isolated HOME and runtimes. */
async function doctor(overrides: Record<string, string>): Promise<string> {
	// Looking like a developer's machine: CI turns every hosts mode off.
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of CI_ENV_VARS) delete env[name];
	const proc = Bun.spawn([process.execPath, cli, "doctor"], {
		cwd: dir,
		env: { ...env, ...overrides },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return `${stdout}${stderr}`;
}

describe("buncargo doctor", () => {
	it("says named hosts are off with BUNCARGO_HOSTS=0, rather than failing the daemon and CA", async () => {
		const report = await doctor({ BUNCARGO_HOSTS: "0" });
		expect(report).toContain("✓ Named hosts are off");
		expect(report).not.toContain("Named-hosts daemon is not running");
		expect(report).not.toContain("Named-hosts CA is not trusted");
	}, 30_000);

	it("checks Tailscale instead of the loopback daemon with BUNCARGO_HOSTS=tailscale", async () => {
		// The test run's `tailscale` on PATH is a stub that fails.
		const report = await doctor({ BUNCARGO_HOSTS: "tailscale" });
		expect(report).toContain(
			"✓ Named hosts are served through Tailscale (BUNCARGO_HOSTS=tailscale)",
		);
		expect(report).toContain("✗ Tailscale: Tailscale is not reachable");
		expect(report).not.toContain("Named-hosts daemon is not running");
		expect(report).not.toContain("Named-hosts CA is not trusted");
	}, 30_000);
});
