import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment } from ".";

const BIN = join(import.meta.dir, "../cli/bin.ts");
const roots: string[] = [];

function checkout(): string {
	const root = mkdtempSync(join(tmpdir(), "buncargo-env-vars-"));
	roots.push(root);
	writeFileSync(join(root, ".env"), "DECLARED=from-file\n");
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {
	projectPrefix: "envvars",
	services: {},
	apps: { web: { port: 3000, devCommand: false } },
	options: { envFiles: [".env"] },
};
`,
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("prints the declared input in env, and none of the rest of the shell", async () => {
	const root = checkout();
	const child = Bun.spawn([process.execPath, BIN, "env"], {
		cwd: root,
		env: { ...process.env, SOME_TOKEN: "exported", DECLARED: "from-shell" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	const { vars } = JSON.parse(stdout) as { vars: Record<string, string> };
	expect(vars.DECLARED).toBe("from-shell");
	expect(vars).not.toHaveProperty("SOME_TOKEN");
	expect(vars).not.toHaveProperty("PWD");
});

it("gives the same fingerprint whatever the shell's PWD and SHLVL", () => {
	const root = checkout();
	const saved = { PWD: process.env.PWD, SHLVL: process.env.SHLVL };
	try {
		const fingerprints = ["/a", "/b"].map((pwd, index) => {
			process.env.PWD = pwd;
			process.env.SHLVL = String(index + 1);
			const env = createDevEnvironment(
				{
					projectPrefix: "envvars",
					services: {},
					apps: { web: { port: 3000, devCommand: false } },
					options: { envFiles: [".env"] },
				},
				{ root },
			);
			return env.buildEnvFingerprint("web");
		});
		expect(fingerprints[0]).toBe(fingerprints[1]);
	} finally {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
});
