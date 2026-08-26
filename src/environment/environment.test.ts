import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDevConfig } from "../config";
import { getProjectName } from "../core/ports";
import type { DevConfig, ServiceConfig } from "../types";
import { createDevEnvironment } from ".";

function createBaseConfig(
	options?: DevConfig<
		Record<string, ServiceConfig>,
		Record<string, never>
	>["options"],
): DevConfig<Record<string, ServiceConfig>, Record<string, never>> {
	return {
		projectPrefix: "myapp",
		services: {
			postgres: { port: 5432 },
		},
		options,
	};
}

function createWorktreeRoot(worktreeName: string): string {
	const root = join(
		tmpdir(),
		`buncargo-env-test-${Date.now()}-${Math.random()}`,
	);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, ".git"),
		`gitdir: /tmp/repo/worktrees/${worktreeName}`,
	);
	return root;
}

const originalCwd = process.cwd();

afterEach(() => {
	process.chdir(originalCwd);
});

describe("createDevEnvironment worktree isolation", () => {
	it("uses worktree suffix in projectName when isolation is enabled (default)", () => {
		const root = createWorktreeRoot("Feature_A");
		try {
			process.chdir(root);
			const env = createDevEnvironment(createBaseConfig());
			expect(env.projectName).toBe(getProjectName("myapp", "feature-a", root));
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not include worktree suffix when isolation is disabled", () => {
		const root = createWorktreeRoot("Feature_A");
		try {
			process.chdir(root);
			const env = createDevEnvironment(
				createBaseConfig({ worktreeIsolation: false }),
			);
			expect(env.projectName).toBe(getProjectName("myapp", undefined, root));
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("composes explicit suffix with worktree suffix in stable order", () => {
		const root = createWorktreeRoot("Feature_A");
		try {
			process.chdir(root);
			const env = createDevEnvironment(createBaseConfig(), { suffix: "test" });
			expect(env.projectName).toBe(
				getProjectName("myapp", "test-feature-a", root),
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("createDevEnvironment compose generation", () => {
	it("uses generated compose path by default", () => {
		const root = createWorktreeRoot("Feature_Compose_Default");
		try {
			process.chdir(root);
			const env = createDevEnvironment(createBaseConfig());
			const composeFile = env.ensureComposeFile();

			expect(env.composeFile).toBe(".buncargo/docker-compose.generated.yml");
			expect(composeFile).toBe(".buncargo/docker-compose.generated.yml");
			expect(
				existsSync(join(root, ".buncargo/docker-compose.generated.yml")),
			).toBe(true);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("respects custom generated compose path from docker config", () => {
		const root = createWorktreeRoot("Feature_Compose_Custom");
		try {
			process.chdir(root);
			const env = createDevEnvironment({
				...createBaseConfig(),
				docker: {
					generatedFile: ".buncargo/custom-compose.yml",
				},
			});
			const composeFile = env.ensureComposeFile();

			expect(env.composeFile).toBe(".buncargo/custom-compose.yml");
			expect(composeFile).toBe(".buncargo/custom-compose.yml");
			expect(existsSync(join(root, ".buncargo/custom-compose.yml"))).toBe(true);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("createDevEnvironment env builders", () => {
	it("keeps shared env separate from app-local env", () => {
		const root = createWorktreeRoot("Feature_App_Env");
		try {
			process.chdir(root);
			const env = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "myapp",
					services: {
						postgres: { port: 5432 },
					},
					apps: {
						api: {
							port: 3000,
							devCommand: "bun run api",
							envVars: (_ports, urls) => ({
								WEBHOOK_URL: urls.api,
							}),
						},
						web: {
							port: 5173,
							devCommand: "bun run web",
							envVars: (_ports, urls) => ({
								VITE_API_URL: urls.api,
							}),
						},
					},
				}),
			);

			expect(env.buildEnvVars().DATABASE_URL).toBe(env.urls.postgres);
			expect(env.buildEnvVars().VITE_API_URL).toBeUndefined();
			expect(env.buildAppEnvVars("web").VITE_API_URL).toBe(env.urls.api);
			expect(env.buildAppEnvVars("api").WEBHOOK_URL).toBe(env.urls.api);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("merges the top-level env overlay onto shared env for every app", () => {
		const root = createWorktreeRoot("Feature_Shared_Env");
		try {
			process.chdir(root);
			const env = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "myapp",
					services: {
						postgres: { port: 5432 },
					},
					apps: {
						api: { port: 3000, devCommand: "bun run api" },
						web: { port: 5173, devCommand: "bun run web", expose: true },
					},
					env: (_ports, urls, { publicUrls }) => ({
						WEB_URL: publicUrls.web ?? `${urls.web}/app`,
						VITE_API_URL: `${urls.api}/api`,
					}),
				}),
			);

			// Type-level: computed names are known, overlay keys fall to the index signature.
			const composeProject: string = env.buildEnvVars().COMPOSE_PROJECT_NAME;
			const apiPort: string = env.buildEnvVars().API_PORT;
			expect(composeProject).toBe(env.projectName);
			expect(apiPort).toBe(String(env.ports.api));

			expect(env.buildEnvVars().VITE_API_URL).toBe(`${env.urls.api}/api`);
			expect(env.buildEnvVars().WEB_URL).toBe(`${env.urls.web}/app`);
			expect(env.buildAppEnvVars("web").VITE_API_URL).toBe(
				`${env.urls.api}/api`,
			);
			expect(env.buildAppEnvVars("api").VITE_API_URL).toBe(
				`${env.urls.api}/api`,
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rewrites app URLs when named hosts are activated", () => {
		const root = createWorktreeRoot("Feature_Hosts");
		const previousCi = process.env.CI;
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.CI;
		delete process.env.BUNCARGO_HOSTS;
		try {
			process.chdir(root);
			const env = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "serpier",
					services: {
						postgres: { port: 5432 },
						mailpit: { port: 8025, secondaryPort: 1025 },
					},
					apps: {
						api: { port: 3000, devCommand: "bun run api" },
						web: { port: 3001, devCommand: "bun run web" },
					},
					options: { hosts: { primaryApp: "web" } },
				}),
			);

			expect(env.hosts?.plan.some((entry) => entry.name === "api")).toBe(true);
			expect(env.urls.api).toBe(`http://localhost:${env.ports.api}`);
			env.setNamedHostsActive(true);
			expect(env.urls.web).toBe("https://feature-hosts.serpier.localhost");
			expect(env.urls.api).toBe("https://feature-hosts.api.serpier.localhost");
			expect(env.urls.mailpit).toBe(
				"https://feature-hosts.mailpit.serpier.localhost",
			);
			expect(env.urls.postgres).toContain("postgresql://");
			expect(env.buildEnvVars().__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(
				".localhost",
			);
			env.setNamedHostsActive(false);
			expect(env.urls.api).toBe(`http://localhost:${env.ports.api}`);
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
