import { afterEach, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import { loadDevEnv } from "../../loader";

const cli = resolve(import.meta.dir, "../bin.ts");
const roots: string[] = [];
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-exec-")));
	roots.push(root);
	mkdirSync(join(root, "packages/api"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ workspaces: ["packages/*"] }),
	);
	writeFileSync(
		join(root, "input.env"),
		"DATABASE_URL=stale\nFIXTURE_DEFAULT=file\n",
	);
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {projectPrefix:'exec',services:{postgres:{port:5432}},apps:{api:{port:3000,devCommand:false,cwd:'packages/api',staticEnv:{APP_ONLY:'yes'}}},options:{envFiles:['input.env']},env:(_p,_u,ctx)=>({FROM_INPUT:ctx.env.FIXTURE_DEFAULT}),prisma:{},migrations:[{name:'never',command:'exit 99'}],seed:{command:'exit 99'}};`,
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("exec passes argv unchanged and uses app environment/cwd from a nested invocation", async () => {
	const root = fixture();
	const args = [
		"space value",
		"a'b",
		'a"b',
		"$HOME",
		"$(touch injected)",
		";",
		"--cwd=child",
	];
	const result = await execAsync(
		[
			process.execPath,
			cli,
			"exec",
			"--app=api",
			"--",
			process.execPath,
			"-e",
			"process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),db:process.env.DATABASE_URL,app:process.env.APP_ONLY,source:process.env.FROM_INPUT}))",
			...args,
		],
		join(root, "packages/api"),
		{},
	);
	const output = JSON.parse(result.stdout);
	expect(output.args).toEqual(args);
	expect(output.cwd).toBe(join(root, "packages/api"));
	expect(output.app).toBe("yes");
	expect(output.source).toBe("file");
	const env = await loadDevEnv({ cwd: root, readOnly: true });
	expect(output.db).toBe(env.prisma?.getDatabaseUrl());
	expect(existsSync(join(root, ".buncargo/ports.json"))).toBe(false);
	expect(existsSync(join(root, "injected"))).toBe(false);
	const explicit = await execAsync(
		[
			process.execPath,
			cli,
			"exec",
			"--app=api",
			"--cwd=.",
			"--",
			process.execPath,
			"-e",
			"process.stdout.write(process.cwd())",
		],
		join(root, "packages/api"),
		{},
	);
	expect(explicit.stdout).toBe(root);
});

it("propagates child exit status and rejects unknown app names", async () => {
	const root = fixture();
	const result = await execAsync(
		[
			process.execPath,
			cli,
			"exec",
			"--",
			process.execPath,
			"-e",
			"process.exit(17)",
		],
		root,
		{},
		{ throwOnError: false },
	);
	expect(result.exitCode).toBe(17);
	const missing = await execAsync(
		[
			process.execPath,
			cli,
			"exec",
			"--app=missing",
			"--",
			process.execPath,
			"-e",
			"process.exit(99)",
		],
		root,
		{},
		{ throwOnError: false },
	);
	expect(missing.exitCode).toBe(1);
	expect(missing.stderr + missing.stdout).toContain('Unknown app "missing"');
});

it("reloads dotenv input on later calls and resolves root/nested calls identically", async () => {
	const root = fixture();
	const first = await loadDevEnv({ cwd: root });
	writeFileSync(join(root, "input.env"), "FIXTURE_DEFAULT=changed\n");
	const next = await loadDevEnv({ cwd: join(root, "packages/api") });
	expect((first.buildEnvVars() as Record<string, string>).FROM_INPUT).toBe(
		"file",
	);
	expect((next.buildEnvVars() as Record<string, string>).FROM_INPUT).toBe(
		"changed",
	);
	expect(next.ports).toEqual(first.ports);
});

it("forwards interruption to the child and returns the shell signal exit status", async () => {
	const root = fixture();
	const observed = join(root, "signal.txt");
	const child = Bun.spawn(
		[
			process.execPath,
			cli,
			"exec",
			"--",
			process.execPath,
			"-e",
			`process.on('SIGINT',()=>{require('node:fs').writeFileSync(${JSON.stringify(observed)},'SIGINT');process.exit(0)});console.log('READY');setInterval(()=>{},1000);`,
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("READY");
		reader.releaseLock();
		child.kill("SIGINT");
		expect(await child.exited).toBe(130);
		expect(await Bun.file(observed).text()).toBe("SIGINT");
	} finally {
		child.kill();
		await child.exited;
	}
});
