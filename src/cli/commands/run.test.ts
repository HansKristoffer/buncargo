import { afterEach, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";

const cli = resolve(import.meta.dir, "../bin.ts");
const roots: string[] = [];
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-run-")));
	roots.push(root);
	mkdirSync(join(root, "packages/api"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ workspaces: ["packages/*"] }),
	);
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {projectPrefix:'run',services:{},apps:{api:{port:3000,devCommand:false,cwd:'packages/api',staticEnv:{APP_ONLY:'yes'}}},tasks:{
			'shop:seed':{command:'printf "%s|%s|" "$APP_ONLY" "$PWD"; printf "%s,"',app:'api',description:'Seed the store'},
			fail:{command:'exit 7'},
		},checks:[{name:'marker',check:({root})=>require('node:fs').existsSync(root+'/marker'),fix:'touch marker'}]};`,
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function buncargo(root: string, ...args: string[]) {
	return execAsync(
		[process.execPath, cli, ...args],
		root,
		{},
		{
			throwOnError: false,
		},
	);
}

it("runs a task with its app's env and cwd, appending argv unparsed", async () => {
	const root = fixture();
	const result = await buncargo(root, "run", "shop:seed", "--", "a b", "$HOME");
	expect(result.stdout).toBe(`yes|${join(root, "packages/api")}|a b,$HOME,`);
	expect(result.exitCode).toBe(0);
	// Reads ports like exec does: no allocation state for a task without services.
	expect(existsSync(join(root, ".buncargo/ports.json"))).toBe(false);
});

it("lists tasks, propagates exit codes and names unknown tasks", async () => {
	const root = fixture();
	const listing = await buncargo(root, "run");
	expect(listing.stdout).toContain("shop:seed  Seed the store");
	expect(listing.stdout).toContain("fail       exit 7");

	expect((await buncargo(root, "run", "fail")).exitCode).toBe(7);

	const unknown = await buncargo(root, "run", "nope");
	expect(unknown.exitCode).toBe(1);
	expect(unknown.stderr).toContain('Unknown task "nope"');
	expect(unknown.stderr).toContain("Available tasks: shop:seed, fail");
});

it("setup only reports without a terminal, and fixes with --yes", async () => {
	const root = fixture();
	const report = await buncargo(root, "setup");
	expect(report.exitCode).toBe(1);
	expect(existsSync(join(root, "marker"))).toBe(false);
	expect(report.stderr).toContain("bunx buncargo setup --yes");

	const result = await buncargo(root, "setup", "--yes");
	expect(result.exitCode).toBe(0);
	expect(existsSync(join(root, "marker"))).toBe(true);
	// The core check's fix, alongside the config's.
	expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(
		".buncargo/",
	);
	expect(result.stdout).toContain("All 2 checks pass.");

	// Idempotent: a ready checkout changes nothing.
	expect((await buncargo(root, "setup")).exitCode).toBe(0);
});
