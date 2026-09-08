import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment } from "../environment";
import { loadEnvInput } from "./env-input";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-env-input-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("loads ordered defaults and inherited values without mutation", () => {
	const root = fixture();
	writeFileSync(join(root, "base.env"), 'A=first\nB="two words"\n');
	writeFileSync(join(root, "local.env"), "A=last\n");
	const inherited = { A: "shell" };
	expect(
		loadEnvInput(
			root,
			["base.env", "local.env", { path: "missing", optional: true }],
			inherited,
		),
	).toEqual({ A: "shell", B: "two words" });
	expect(inherited).toEqual({ A: "shell" });
	expect(readFileSync(join(root, "base.env"), "utf8")).toContain(
		'B="two words"',
	);
	expect(() => loadEnvInput(root, ["missing"], {})).toThrow(
		"Cannot load environment input",
	);
});

it("local generated values outrank dotenv and app overlays stay authoritative", async () => {
	const root = fixture();
	writeFileSync(
		join(root, "input.env"),
		"DATABASE_URL=stale\nINPUT_SECRET=fixture\n",
	);
	const env = createDevEnvironment(
		{
			projectPrefix: "input",
			services: { postgres: { port: 5432 } },
			apps: {
				api: {
					port: 3000,
					devCommand: false,
					envVars: () => ({ DATABASE_URL: "app-specific" }),
				},
			},
			options: { envFiles: ["input.env"] },
			env: (_ports, urls, ctx) => ({
				ALIAS: urls.postgres,
				FROM_INPUT: ctx.env?.INPUT_SECRET,
			}),
		},
		{ root },
	);
	expect(env.buildEnvVars().DATABASE_URL).toBe(env.urls.postgres);
	expect(env.buildEnvVars().FROM_INPUT).toBe("fixture");
	expect(env.buildAppEnvVars("api").DATABASE_URL).toBe("app-specific");
	const other = createDevEnvironment(
		{ projectPrefix: "other", services: {}, apps: {} },
		{ root: fixture() },
	);
	expect(other.buildEnvVars()).not.toHaveProperty("INPUT_SECRET");
	expect(process.env.INPUT_SECRET).toBeUndefined();
	const result = await env.exec([
		process.execPath,
		"-e",
		"process.stdout.write(process.env.DATABASE_URL ?? '')",
	]);
	expect(result.stdout).toBe(env.urls.postgres);
	expect(readFileSync(join(root, "input.env"), "utf8")).toContain(
		"DATABASE_URL=stale",
	);
});
