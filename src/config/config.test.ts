import { describe, expect, it } from "bun:test";
import type { AppConfig, DevConfig, ServiceConfig } from "../types";
import { defineDevConfig, mergeConfigs, validateConfig } from ".";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createValidConfig(): DevConfig<
	{ postgres: ServiceConfig },
	{ api: AppConfig }
> {
	return {
		projectPrefix: "myapp",
		services: {
			postgres: { port: 5432 },
		},
		apps: {
			api: { port: 3000, devCommand: "bun run dev" },
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// validateConfig Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("validateConfig", () => {
	describe("projectPrefix validation", () => {
		it("returns error when projectPrefix is missing", () => {
			const config = createValidConfig();
			config.projectPrefix = "";

			const errors = validateConfig(config);

			expect(errors).toContain("projectPrefix is required");
		});

		it("returns error when projectPrefix starts with number", () => {
			const config = createValidConfig();
			config.projectPrefix = "1myapp";

			const errors = validateConfig(config);

			expect(errors).toContain(
				"projectPrefix must start with a letter and contain only lowercase letters, numbers, and hyphens",
			);
		});

		it("returns error when projectPrefix contains uppercase", () => {
			const config = createValidConfig();
			config.projectPrefix = "MyApp";

			const errors = validateConfig(config);

			expect(errors).toContain(
				"projectPrefix must start with a letter and contain only lowercase letters, numbers, and hyphens",
			);
		});

		it("returns error when projectPrefix contains special characters", () => {
			const config = createValidConfig();
			config.projectPrefix = "my_app";

			const errors = validateConfig(config);

			expect(errors).toContain(
				"projectPrefix must start with a letter and contain only lowercase letters, numbers, and hyphens",
			);
		});

		it("accepts valid projectPrefix with letters, numbers, and hyphens", () => {
			const config = createValidConfig();
			config.projectPrefix = "my-app-123";

			const errors = validateConfig(config);

			expect(errors).not.toContain(
				"projectPrefix must start with a letter and contain only lowercase letters, numbers, and hyphens",
			);
		});
	});

	describe("services validation", () => {
		it("returns error when services is empty", () => {
			const config = createValidConfig();
			// @ts-expect-error - testing invalid config
			config.services = {};

			const errors = validateConfig(config);

			expect(errors).toContain("At least one service is required");
		});

		it("returns error when service has no port", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: {},
				},
			} as unknown as DevConfig<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Service "postgres" must have a valid port number',
			);
		});

		it("returns error when service port is 0", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 0 },
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Service "postgres" port must be between 1 and 65535',
			);
		});

		it("returns error when service port exceeds 65535", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 65536 },
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Service "postgres" port must be between 1 and 65535',
			);
		});

		it("accepts valid service port", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
			};

			const errors = validateConfig(config);

			expect(errors).toHaveLength(0);
		});
	});

	describe("apps validation", () => {
		it("returns error when app has no devCommand", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: { port: 3000 },
				},
			} as unknown as DevConfig<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			const errors = validateConfig(config);

			expect(errors).toContain('App "api" must have a devCommand');
		});

		it("returns error when app has no port", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: { devCommand: "bun run dev" },
				},
			} as unknown as DevConfig<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			const errors = validateConfig(config);

			expect(errors).toContain('App "api" must have a valid port number');
		});

		it("accepts valid app config", () => {
			const config = createValidConfig();

			const errors = validateConfig(config);

			expect(errors).toHaveLength(0);
		});

		it("returns error when app requires an unknown service", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: {
						port: 3000,
						devCommand: "bun run dev",
						requiredServices: ["redis"],
					},
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain('App "api" requires unknown service "redis"');
		});

		it("returns error when app requires an unknown app", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					expo: {
						port: 8081,
						devCommand: "bun run expo",
						requiredApps: ["api"],
					},
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain('App "expo" requires unknown app "api"');
		});

		it("returns error when requiredApps contain a cycle", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: {
						port: 3000,
						devCommand: "bun run api",
						requiredApps: ["expo"],
					},
					expo: {
						port: 8081,
						devCommand: "bun run expo",
						requiredApps: ["api"],
					},
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				"Circular requiredApps dependency: api -> expo -> api",
			);
		});
	});

	describe("valid config", () => {
		it("returns empty errors array for valid config", () => {
			const config = createValidConfig();

			const errors = validateConfig(config);

			expect(errors).toHaveLength(0);
		});

		it("accepts config without apps", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
			};

			const errors = validateConfig(config);

			expect(errors).toHaveLength(0);
		});
	});

	describe("docker generation validation", () => {
		it("returns error when generatedFile is absolute", () => {
			const config = createValidConfig();
			config.docker = { generatedFile: "/tmp/docker-compose.yml" };

			const errors = validateConfig(config);

			expect(errors).toContain(
				"docker.generatedFile must be a relative path inside the repo.",
			);
		});

		it("returns error when generatedFile points outside repo", () => {
			const config = createValidConfig();
			config.docker = { generatedFile: "../docker-compose.yml" };

			const errors = validateConfig(config);

			expect(errors).toContain(
				"docker.generatedFile cannot point outside the repository root.",
			);
		});

		it("returns error for non-built-in service without docker definition", () => {
			const config: DevConfig<
				{ nats: ServiceConfig },
				Record<string, never>
			> = {
				projectPrefix: "myapp",
				services: {
					nats: { port: 4222 },
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Service "nats" must define docker config (helper or raw) because it has no built-in preset.',
			);
		});

		it("returns error for duplicate compose service names", () => {
			const config: DevConfig<
				{ postgres: ServiceConfig; shadow: ServiceConfig },
				Record<string, never>
			> = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432, serviceName: "database" },
					shadow: {
						port: 5433,
						serviceName: "database",
						docker: { image: "postgres:16-alpine" },
					},
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Duplicate compose service name "database". Use unique serviceName values.',
			);
		});
	});

	describe("prisma validation", () => {
		it("returns error when prisma.service is unknown", () => {
			const config = createValidConfig();
			config.prisma = { service: "redis" };

			const errors = validateConfig(config);

			expect(errors).toContain(
				'prisma.service "redis" must match a configured service key',
			);
		});

		it("returns error when prisma.cwd is absolute", () => {
			const config = createValidConfig();
			config.prisma = { cwd: "/tmp/prisma" };

			const errors = validateConfig(config);

			expect(errors).toContain(
				"prisma.cwd must be a relative path inside the repo.",
			);
		});

		it("returns error when prisma.cwd points outside the repo", () => {
			const config = createValidConfig();
			config.prisma = { cwd: "../prisma" };

			const errors = validateConfig(config);

			expect(errors).toContain(
				"prisma.cwd cannot point outside the repository root.",
			);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// mergeConfigs Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("mergeConfigs", () => {
	it("merges projectPrefix from override", () => {
		const base = createValidConfig();
		const override = { projectPrefix: "newapp" };

		const result = mergeConfigs(base, override);

		expect(result.projectPrefix).toBe("newapp");
	});

	it("deep merges services", () => {
		const base = createValidConfig();
		const override = {
			services: {
				redis: { port: 6379 },
			},
		};

		// @ts-expect-error - testing merge behavior
		const result = mergeConfigs(base, override);

		expect(result.services.postgres).toEqual({ port: 5432 });
		// @ts-expect-error - testing merge behavior
		expect(result.services.redis).toEqual({ port: 6379 });
	});

	it("deep merges apps", () => {
		const base = createValidConfig();
		const override = {
			apps: {
				web: { port: 5173, devCommand: "bun run dev:web" },
			},
		};

		// @ts-expect-error - testing merge behavior
		const result = mergeConfigs(base, override);

		expect(result.apps?.api).toEqual({ port: 3000, devCommand: "bun run dev" });
		// @ts-expect-error - testing merge behavior
		expect(result.apps?.web).toEqual({
			port: 5173,
			devCommand: "bun run dev:web",
		});
	});

	it("preserves app dependency metadata when merging apps", () => {
		const base: DevConfig<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		> = {
			projectPrefix: "deps",
			services: {
				postgres: { port: 5432 },
				redis: { port: 6379 },
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
					requiredServices: ["postgres", "redis"],
				},
			},
		};
		const override: Partial<
			DevConfig<Record<string, ServiceConfig>, Record<string, AppConfig>>
		> = {
			apps: {
				expo: {
					port: 8081,
					devCommand: "bun run expo",
					requiredApps: ["api"],
				},
			},
		};

		const result = mergeConfigs(base, override);

		expect(result.apps?.api.requiredServices).toEqual(["postgres", "redis"]);
		expect(result.apps?.expo.requiredApps).toEqual(["api"]);
	});

	it("deep merges hooks", () => {
		const hook1 = async () => {};
		const hook2 = async () => {};

		const base: DevConfig<
			{ postgres: ServiceConfig },
			Record<string, never>
		> = {
			projectPrefix: "myapp",
			services: { postgres: { port: 5432 } },
			hooks: { afterContainersReady: hook1 },
		};
		const override = {
			hooks: { beforeServers: hook2 },
		};

		const result = mergeConfigs(base, override);

		expect(result.hooks?.afterContainersReady).toBe(hook1);
		expect(result.hooks?.beforeServers).toBe(hook2);
	});

	it("deep merges options", () => {
		const base: DevConfig<
			{ postgres: ServiceConfig },
			Record<string, never>
		> = {
			projectPrefix: "myapp",
			services: { postgres: { port: 5432 } },
			options: { worktreeIsolation: true, verbose: true },
		};
		const override = {
			options: { verbose: false },
		};

		const result = mergeConfigs(base, override);

		expect(result.options?.worktreeIsolation).toBe(true);
		expect(result.options?.verbose).toBe(false);
	});

	it("override takes precedence for conflicting values", () => {
		const base = createValidConfig();
		const override = {
			services: {
				postgres: { port: 5433 },
			},
		};

		const result = mergeConfigs(base, override);

		expect(result.services.postgres.port).toBe(5433);
	});
});

describe("envVars publicUrls typing", () => {
	it("infers publicUrls keys from expose:true services/apps", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: {
					port: 5432,
					expose: true,
					docker: {
						image: "postgres:16-alpine",
					},
				},
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run dev",
					expose: true,
				},
			},
			envVars: (_ports, _urls, { publicUrls }) => {
				const maybeApi: string | undefined = publicUrls.api;
				const maybePostgres: string | undefined = publicUrls.postgres;
				return {
					PUBLIC_API_URL: maybeApi ?? "",
					PUBLIC_POSTGRES_URL: maybePostgres ?? "",
				};
			},
		});

		expect(config.projectPrefix).toBe("typed");
	});
});

describe("defineDevConfig app dependency typing", () => {
	it("infers requiredServices and requiredApps from configured keys", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: {
					port: 5432,
				},
				redis: {
					port: 6379,
				},
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
					requiredServices: ["postgres"],
				},
				expo: {
					port: 8081,
					devCommand: "bun run expo",
					requiredApps: ["api"],
					requiredServices: ["redis"],
				},
			},
		});

		expect(config.projectPrefix).toBe("typed");
	});

	it("rejects unknown requiredApps at compile time", () => {
		defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: {
					port: 5432,
				},
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
				web: {
					port: 5173,
					devCommand: "bun run web",
					// @ts-expect-error - "missing" is not a configured app
					requiredApps: ["missing"],
				},
			},
		});
	});

	it("rejects unknown requiredServices at compile time", () => {
		defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: {
					port: 5432,
				},
				redis: {
					port: 6379,
				},
			},
			apps: {
				worker: {
					port: 3001,
					devCommand: "bun run worker",
					// @ts-expect-error - "nats" is not a configured service
					requiredServices: ["nats"],
				},
			},
		});
	});
});
