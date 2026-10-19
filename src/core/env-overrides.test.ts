import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment } from "../environment";
import { loadEnvInput } from "./env-input";
import {
	parseEnvAssignment,
	readEnvOverrides,
	updateEnvOverrides,
} from "./env-overrides";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-env-overrides-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("parses KEY=VALUE, keeping = and empty values, and rejects the rest", () => {
	expect(parseEnvAssignment("A=b=c")).toEqual({ key: "A", value: "b=c" });
	expect(parseEnvAssignment("EMPTY=")).toEqual({ key: "EMPTY", value: "" });
	expect(parseEnvAssignment("NOVALUE")).toHaveProperty("error");
	expect(parseEnvAssignment("1BAD=x")).toHaveProperty("error");
});

it("stores, replaces and drops overrides per checkout", async () => {
	const root = fixture();
	await updateEnvOverrides(root, { set: { B: "1", A: "2" } });
	await updateEnvOverrides(root, { set: { B: "3" }, unset: ["A"] });
	expect(readEnvOverrides(root)).toEqual({ B: "3" });
	expect(readEnvOverrides(fixture())).toEqual({});
});

it("wins over env files, buncargo's values and an app's own envVars, but not the shell", async () => {
	const root = fixture();
	writeFileSync(
		join(root, ".env.local"),
		"UPSTASH_REDIS_REST_URL=http://localhost:8079\n",
	);
	await updateEnvOverrides(root, {
		set: {
			UPSTASH_REDIS_REST_URL: "http://localhost:8779",
			DATABASE_URL: "postgres://override",
			FROM_SHELL: "override",
		},
	});

	expect(
		loadEnvInput(
			root,
			[".env.local"],
			{ FROM_SHELL: "shell" },
			readEnvOverrides(root),
		),
	).toMatchObject({
		UPSTASH_REDIS_REST_URL: "http://localhost:8779",
		FROM_SHELL: "shell",
	});

	const env = createDevEnvironment(
		{
			projectPrefix: "overrides",
			services: { postgres: { port: 5432 } },
			apps: {
				api: {
					port: 3000,
					devCommand: false,
					envVars: () => ({ DATABASE_URL: "app-specific" }),
				},
			},
			options: { envFiles: [{ path: ".env.local", optional: true }] },
			env: (_ports, _urls, ctx) => ({
				UPSTASH_REDIS_REST_URL: ctx.env?.UPSTASH_REDIS_REST_URL ?? "computed",
			}),
		},
		{ root },
	);
	const shared = env.buildEnvVars() as Record<string, string>;
	expect(shared.UPSTASH_REDIS_REST_URL).toBe("http://localhost:8779");
	expect(shared.DATABASE_URL).toBe("postgres://override");
	const app = env.buildAppEnvVars("api") as Record<string, string>;
	expect(app.DATABASE_URL).toBe("postgres://override");
});
