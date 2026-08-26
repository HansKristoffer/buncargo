import { describe, expect, it } from "bun:test";
import { getEnvVar } from "../core/utils";
import { service } from "../docker-compose/services";
import type {
	AnyDevConfig,
	AppConfig,
	ComputedPublicUrls,
	DevConfig,
	EnvValues,
	ServiceConfig,
} from "../types";
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

		it("returns error for duplicate derived env aliases", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					primary: service.custom({
						port: 5432,
						env: {
							DATABASE_URL: "url",
						},
						docker: {
							image: "postgres:16-alpine",
						},
					}),
					replica: service.custom({
						port: 5433,
						env: {
							DATABASE_URL: "url",
						},
						docker: {
							image: "postgres:16-alpine",
						},
					}),
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Derived env var "DATABASE_URL" is declared by multiple services (primary, replica). Rename one of them or use explicit service.env mappings.',
			);
		});

		it("returns error when service env uses secondaryPort without configuring it", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					clickhouse: service.custom({
						port: 8123,
						env: {
							CLICKHOUSE_TCP_PORT: "secondaryPort",
						},
						docker: {
							image: "clickhouse/clickhouse-server:24-alpine",
						},
					}),
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				'Service "clickhouse" declares env "CLICKHOUSE_TCP_PORT" from secondaryPort but no secondaryPort is configured.',
			);
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

		it("accepts devCommand: false and healthEndpoint: false", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					metro: {
						port: 8081,
						devCommand: false as const,
						healthEndpoint: false as const,
					},
				},
			};

			expect(validateConfig(config)).toHaveLength(0);
		});

		it("returns error when more than one app is interactive", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: {
						port: 3000,
						devCommand: "bun run api",
						interactive: true,
					},
					expo: {
						port: 8081,
						devCommand: "bun run expo",
						interactive: true,
					},
				},
			};

			const errors = validateConfig(config);

			expect(errors).toContain(
				"Only one app may set interactive: true. Found: api, expo",
			);
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

		it("accepts a top-level env overlay", () => {
			const config = defineDevConfig({
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					web: { port: 5173, devCommand: "bun run dev" },
				},
				env: (_ports, urls) => ({
					VITE_API_URL: urls.postgres,
				}),
			});

			expect(validateConfig(config)).toEqual([]);
		});

		it("returns an upgrade error for removed top-level envVars", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				envVars: () => ({
					DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/myapp",
				}),
			} as unknown as DevConfig<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			const errors = validateConfig(config);

			expect(errors).toContain(
				"Top-level envVars has been removed. Use the top-level env overlay for shared values, or apps.<name>.envVars for app-only values.",
			);
		});

		it("returns an upgrade error for the renamed per-app env key", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: {
						port: 3000,
						devCommand: "bun run dev",
						env: { SECRETS_ENV: "dev" },
					},
				},
			} as unknown as DevConfig<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			const errors = validateConfig(config);

			expect(errors).toContain(
				'App "api" uses "env", which was renamed to "staticEnv" to avoid colliding with the top-level env overlay. Use apps.api.staticEnv for constants, or apps.api.envVars for computed values.',
			);
		});

		it("accepts the renamed staticEnv key", () => {
			const config = {
				projectPrefix: "myapp",
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: {
						port: 3000,
						devCommand: "bun run dev",
						staticEnv: { SECRETS_ENV: "dev" },
					},
				},
			} as unknown as DevConfig<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>;

			expect(validateConfig(config)).toEqual([]);
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

		it("accepts every valid docker.runtime", () => {
			for (const runtime of ["docker", "apple", "auto"] as const) {
				const config = createValidConfig();
				config.docker = { runtime };
				expect(validateConfig(config)).toEqual([]);
			}
		});

		it("returns error for an unknown docker.runtime", () => {
			const config = createValidConfig();
			config.docker = {
				runtime: "podman" as unknown as "docker",
			};

			expect(validateConfig(config)).toContain(
				'docker.runtime "podman" is invalid. Use "docker", "apple", "auto".',
			);
		});

		it("returns error when docker.binary is relative", () => {
			const config = createValidConfig();
			config.docker = { binary: "bin/container" };

			expect(validateConfig(config)).toContain(
				"docker.binary must be an absolute path to a runtime binary.",
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
			// A typed config rejects this at compile time; the runtime guard covers
			// configs loaded from disk, whose service keys are only known as strings.
			const config = createValidConfig() as AnyDevConfig;
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

	it("composes the shared env builders instead of replacing", () => {
		const base: DevConfig<
			{ postgres: ServiceConfig },
			Record<string, never>
		> = {
			projectPrefix: "myapp",
			services: { postgres: { port: 5432 } },
			env: () => ({ FROM_BASE: "1", SHARED: "base" }),
		};
		const override = {
			env: () => ({ FROM_OVERRIDE: "1", SHARED: "override" }),
		};

		const result = mergeConfigs(base, override);
		const ctx = {
			projectName: "myapp",
			localIp: "127.0.0.1",
			portOffset: 0,
			publicUrls: {},
			loopbackUrls: { postgres: "http://localhost:5432" },
		};

		expect(result.env?.({ postgres: 5432 }, { postgres: "" }, ctx)).toEqual({
			FROM_BASE: "1",
			FROM_OVERRIDE: "1",
			SHARED: "override",
		});
	});

	it("keeps optional groups undefined when neither side sets them", () => {
		const base: DevConfig<
			{ postgres: ServiceConfig },
			Record<string, never>
		> = {
			projectPrefix: "myapp",
			services: { postgres: { port: 5432 } },
		};

		const result = mergeConfigs(base, {});

		expect(result.apps).toBeUndefined();
		expect(result.env).toBeUndefined();
		expect(result.hooks).toBeUndefined();
		expect(result.options).toBeUndefined();
		expect(result.docker).toBeUndefined();
	});
});

describe("app envVars publicUrls typing", () => {
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
					envVars: (_ports, _urls, { publicUrls }) => {
						const maybeApi: string | undefined = publicUrls.api;
						const maybePostgres: string | undefined = publicUrls.postgres;
						return {
							PUBLIC_API_URL: maybeApi ?? "",
							PUBLIC_POSTGRES_URL: maybePostgres ?? "",
						};
					},
				},
			},
		});

		expect(config.projectPrefix).toBe("typed");
	});

	it("omits services/apps that did not opt into expose", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: {
					port: 5432,
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
				web: {
					port: 5173,
					devCommand: "bun run dev",
				},
			},
		});

		type PublicUrls = ComputedPublicUrls<
			typeof config.services,
			NonNullable<typeof config.apps>
		>;

		const exposedApi: string | undefined = ({} as PublicUrls).api;
		expect(exposedApi).toBeUndefined();

		// @ts-expect-error - postgres did not opt into expose
		void ({} as PublicUrls).postgres;
		// @ts-expect-error - web did not opt into expose
		void ({} as PublicUrls).web;
	});

	it("rejects *_PUBLIC_URL env names for non-exposed keys", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run dev",
					expose: true,
				},
				web: {
					port: 5173,
					devCommand: "bun run dev",
				},
			},
		});

		const apiPublicUrl: string | number | undefined = getEnvVar(
			config,
			"API_PUBLIC_URL",
		);
		expect(apiPublicUrl).toBeUndefined();

		// @ts-expect-error - web is not exposed, so WEB_PUBLIC_URL never exists
		getEnvVar(config, "WEB_PUBLIC_URL");
	});
});

describe("getEnvVar typing", () => {
	it("accepts shared computed env names and declared service env outputs", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
				nats: service.custom({
					port: 4222,
					env: {
						NATS_URL: "url",
					},
					docker: {
						image: "nats:2-alpine",
					},
				}),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
				web: {
					port: 5173,
					devCommand: "bun run web",
				},
			},
		});

		const databaseUrl: string | number | undefined = getEnvVar(
			config,
			"DATABASE_URL",
		);
		const natsUrl: string | number | undefined = getEnvVar(config, "NATS_URL");
		const apiUrl: string | number | undefined = getEnvVar(config, "API_URL");
		const webPort: string | number | undefined = getEnvVar(config, "WEB_PORT");

		expect(databaseUrl).toBeDefined();
		expect(natsUrl).toBeDefined();
		expect(apiUrl).toBeDefined();
		expect(webPort).toBeDefined();
	});

	it("rejects unknown shared env names at compile time", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
			},
		});

		// @ts-expect-error - unknown shared env name
		getEnvVar(config, "MISSING_URL");
	});

	it("accepts overlay keys inferred from env and rejects unknown ones", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
				platform: {
					port: 5173,
					devCommand: "bun run web",
				},
			},
			env: (ports, urls) => ({
				VITE_PORT: ports.platform,
				VITE_API_URL: urls.api,
			}),
		});

		const vitePort: number = getEnvVar(config, "VITE_PORT");
		const viteApiUrl: string = getEnvVar(config, "VITE_API_URL");
		const caCerts: string | number | undefined = getEnvVar(
			config,
			"NODE_EXTRA_CA_CERTS",
		);
		const viteHosts: string | number | undefined = getEnvVar(
			config,
			"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
		);

		expect(vitePort).toBeGreaterThan(0);
		expect(viteApiUrl).toMatch(/^http:\/\//);
		expect(caCerts).toBeUndefined();
		expect(viteHosts).toBeUndefined();

		// @ts-expect-error - overlay key was never declared
		getEnvVar(config, "NOT_A_REAL_VAR");
	});

	it("does not treat a wide EnvValues overlay as every string", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
			},
			env: (ports) =>
				({
					VITE_PORT: ports.postgres,
				}) as EnvValues,
		});

		const postgresPort: string | number | undefined = getEnvVar(
			config,
			"POSTGRES_PORT",
		);
		expect(postgresPort).toBeDefined();

		// @ts-expect-error - wide EnvValues must not unlock arbitrary names
		getEnvVar(config, "VITE_PORT");
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

describe("defineDevConfig factory inference", () => {
	it("keeps app keys when defineDevConfig is returned from a factory", () => {
		function createConfig(e2e = false) {
			return defineDevConfig({
				projectPrefix: "typed",
				services: {
					postgres: service.postgres({ database: "typed" }),
					redis: service.redis(),
				},
				apps: {
					api: {
						port: 3000,
						expose: true,
						devCommand: "bun run api",
						requiredServices: ["postgres", "redis"],
					},
					platform: {
						port: 5173,
						expose: true,
						devCommand: "bun run web",
						requiredApps: ["api"],
					},
					expoApp: {
						port: 8081,
						devCommand: "bunx expo start",
						healthEndpoint: false,
						expose: true,
						requiredApps: ["api"],
						envVars: (_ports, _urls, { publicUrls }) => ({
							...(publicUrls.expoApp
								? { EXPO_PACKAGER_PROXY_URL: publicUrls.expoApp }
								: {}),
						}),
					},
				},
				env: (ports, urls, { publicUrls, localIp }) => ({
					VITE_API_URL: publicUrls.api ?? urls.api,
					VITE_PORT: ports.platform,
					EXPO_PUBLIC_API_URL:
						publicUrls.api ?? `http://${localIp}:${ports.api}`,
					...(e2e ? { E2E_TEST: "true" } : {}),
				}),
				options: e2e ? undefined : { hosts: { primaryApp: "platform" } },
			});
		}

		const config = createConfig();
		const apps = config.apps;
		expect(apps?.api.port).toBe(3000);
		expect(apps?.expoApp.port).toBe(8081);

		type Apps = NonNullable<typeof config.apps>;
		type _HasApi = Apps["api"];
		type _HasExpo = Apps["expoApp"];
		const apiPort: Apps["api"]["port"] = 3000;
		expect(apiPort).toBe(3000);

		// @ts-expect-error - "missing" is not a configured app
		const _missing: Apps["missing"] = apps?.api;
		void _missing;

		const vitePort: number = getEnvVar(config, "VITE_PORT");
		const viteApiUrl: string = getEnvVar(config, "VITE_API_URL");
		expect(vitePort).toBeGreaterThan(0);
		expect(viteApiUrl).toMatch(/^https?:\/\//);

		// @ts-expect-error - overlay key was never declared
		getEnvVar(config, "NOT_A_REAL_VAR");
	});
});

describe("validateConfig hosts", () => {
	it("accepts hosts: true", () => {
		const config = createValidConfig();
		config.options = { hosts: true };
		expect(validateConfig(config)).toEqual([]);
	});

	it("rejects an unknown primaryApp", () => {
		// A typed config rejects this at compile time; the runtime guard covers
		// configs loaded from disk, whose app keys are only known as strings.
		const config = createValidConfig() as AnyDevConfig;
		config.options = { hosts: { primaryApp: "web" } };
		expect(validateConfig(config)).toContain(
			'options.hosts.primaryApp "web" must match a configured app key',
		);
	});

	it("rejects a primaryApp that is not a configured app key at compile time", () => {
		const config = createValidConfig();
		// @ts-expect-error - "web" is not a configured app key
		config.options = { hosts: { primaryApp: "web" } };
		expect(config.options).toBeDefined();
	});

	it("rejects an invalid tld", () => {
		const config = createValidConfig();
		config.options = { hosts: { tld: "-bad" } };
		expect(
			validateConfig(config).some((error) => error.includes("hosts.tld")),
		).toBe(true);
	});
});

describe("validateConfig helper app options", () => {
	it("accepts helper app keys that exist", () => {
		const config = createValidConfig();
		config.options = { expoApiApp: "api", frontendApp: "api" };
		expect(validateConfig(config)).toEqual([]);
	});

	it("rejects unknown expoApiApp and frontendApp keys", () => {
		const config = createValidConfig() as AnyDevConfig;
		config.options = { expoApiApp: "mobile", frontendApp: "web" };
		expect(validateConfig(config)).toEqual([
			'options.expoApiApp "mobile" must match a configured app key',
			'options.frontendApp "web" must match a configured app key',
		]);
	});
});
