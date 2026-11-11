import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppleRunPlan } from "../apple-container/run-plan";
import { resolveServices } from "../config/resolve";
import {
	assignedPortTargets,
	buildComposeModel,
	composeToYaml,
	writeGeneratedComposeFile,
} from "./index";
import { serviceHashEnv } from "./interpolate";
import { service } from "./services";

describe("buildComposeModel", () => {
	it("builds built-in postgres/redis/clickhouse services", () => {
		const services = resolveServices({
			postgres: {
				port: 5432,
				healthCheck: "pg_isready",
				database: "geysier",
			},
			redis: {
				port: 6379,
				healthCheck: "redis-cli",
			},
			clickhouse: {
				port: 8123,
				secondaryPort: 9000,
				healthCheck: "http",
				database: "geysier",
			},
		});

		const compose = buildComposeModel(services);

		expect(compose.services.postgres?.image).toBe("pgvector/pgvector:pg16");
		expect(compose.services.redis?.image).toBe("redis:7-alpine");
		expect(compose.services.clickhouse?.image).toBe(
			"clickhouse/clickhouse-server:24-alpine",
		);
		expect(compose.services.postgres?.ports).toEqual([
			"127.0.0.1:$" + "{POSTGRES_PORT:-5432}:5432",
		]);
		expect(compose.services.clickhouse?.ports).toEqual([
			"127.0.0.1:$" + "{CLICKHOUSE_PORT:-8123}:8123",
			"127.0.0.1:$" + "{CLICKHOUSESECONDARY_PORT:-9000}:9000",
		]);
		expect(compose.volumes).toEqual({
			postgres_data: {},
			clickhouse_data: {},
		});
		expect(compose.name).toBe("$" + "{COMPOSE_PROJECT_NAME}");
	});

	it("probes PostgreSQL over TCP for default and explicit health checks", () => {
		const compose = buildComposeModel(
			resolveServices({
				postgres: { port: 5432 },
				db: service.postgres({
					user: "application",
					healthCheck: "pg_isready",
				}),
			}),
		);
		expect(compose.services.postgres?.healthcheck?.test).toEqual([
			"CMD-SHELL",
			"pg_isready -h 127.0.0.1 -U postgres",
		]);
		expect(compose.services.db?.healthcheck?.test).toEqual([
			"CMD-SHELL",
			"pg_isready -h 127.0.0.1 -U application",
		]);
	});

	it("stamps identity labels when provided", () => {
		const compose = buildComposeModel(
			resolveServices({ postgres: { port: 5432 } }),
			undefined,
			{
				projectName: "gey-main",
				root: "/repo",
				worktree: "feature",
			},
		);
		expect(compose.services.postgres?.labels).toEqual({
			"buncargo.project": "gey-main",
			"buncargo.root": "/repo",
			"buncargo.worktree": "feature",
			"buncargo.service": "postgres",
			// Substituted by whichever backend runs it: the hash covers the
			// interpolated file, so it is not known when this is written.
			"buncargo.service-hash": `\${${serviceHashEnv("postgres")}:-}`,
		});
	});

	it("supports helper and raw custom service definitions", () => {
		const services = resolveServices({
			postgres: service.postgres({
				docker: {
					image: "postgres:16-alpine",
				},
			}),
			rabbitmq: service.custom({
				port: 5672,
				healthCheck: false,
				docker: {
					image: "rabbitmq:3-management-alpine",
					ports: ["$" + "{RABBITMQ_PORT:-5672}:5672"],
					environment: {
						RABBITMQ_DEFAULT_USER: "guest",
						RABBITMQ_DEFAULT_PASS: "guest",
					},
				},
			}),
			nats: service.custom({
				port: 4222,
				docker: {
					image: "nats:2-alpine",
				},
			}),
		});

		const compose = buildComposeModel(services);

		expect(compose.services.postgres?.image).toBe("postgres:16-alpine");
		expect(compose.services.rabbitmq?.image).toBe(
			"rabbitmq:3-management-alpine",
		);
		expect(compose.services.nats?.ports).toEqual([
			"127.0.0.1:$" + "{NATS_PORT:-4222}:4222",
		]);
	});

	it("builds mailpit and typesense presets", () => {
		const compose = buildComposeModel(
			resolveServices({
				mailpit: service.mailpit(),
				typesense: service.typesense({ apiKey: "xyz" }),
			}),
		);

		expect(compose.services.mailpit?.image).toBe("axllent/mailpit:v1.33.1");
		expect(compose.services.mailpit?.ports).toEqual([
			"127.0.0.1:$" + "{MAILPIT_PORT:-8025}:8025",
			"127.0.0.1:$" + "{MAILPITSECONDARY_PORT:-1025}:1025",
		]);
		expect(compose.services.typesense?.image).toBe("typesense/typesense:29.0");
		// Neither preset may emit an in-container probe by default: mailpit opts
		// out, and the typesense image ships no wget/curl to run one with.
		expect(compose.services.mailpit?.healthcheck).toBeUndefined();
		expect(compose.services.typesense?.healthcheck).toBeUndefined();
		expect(compose.volumes).toEqual({
			mailpit_data: {},
			typesense_data: {},
		});
	});

	it("emits no container healthcheck for healthCheck: tcp", () => {
		const compose = buildComposeModel(
			resolveServices({
				postgres: service.postgres({ healthCheck: "tcp" }),
				redis: service.redis({ healthCheck: "tcp" }),
			}),
		);

		expect(compose.services.postgres?.healthcheck).toBeUndefined();
		expect(compose.services.redis?.healthcheck).toBeUndefined();
	});

	it("takes a raw definition under a preset's key as written", () => {
		const services = resolveServices({
			postgres: {
				port: 5432,
				docker: {
					image: "postgres:16-alpine",
				},
			},
		});

		const compose = buildComposeModel(services);
		expect(compose.services.postgres).toEqual({
			image: "postgres:16-alpine",
			ports: ["127.0.0.1:$" + "{POSTGRES_PORT:-5432}:5432"],
		});
		expect(compose.volumes).toBeUndefined();
	});
});

describe("buildComposeModel with assigned ports", () => {
	const services = resolveServices({
		clickhouse: { port: 8123, secondaryPort: 9000 },
		cache: service.custom({
			port: 6380,
			docker: { image: "redis:7", ports: ["127.0.0.1:6380:6379"] },
		}),
	});

	it("lets the runtime pick the host port of every port it generates", () => {
		const compose = buildComposeModel(
			services,
			undefined,
			undefined,
			"docker",
			{
				ports: "assigned",
			},
		);

		expect(compose.services.clickhouse?.ports).toEqual([
			"127.0.0.1::8123",
			"127.0.0.1::9000",
		]);
		expect(compose.services.cache?.ports).toEqual(["127.0.0.1:6380:6379"]);
		expect(assignedPortTargets(services, compose)).toEqual({
			clickhouse: { service: "clickhouse", containerPort: 8123 },
			clickhouseSecondary: { service: "clickhouse", containerPort: 9000 },
		});
	});

	it("reads back nothing from a model on claimed ports", () => {
		expect(assignedPortTargets(services, buildComposeModel(services))).toEqual(
			{},
		);
	});
});

describe("buildComposeModel with data on tmpfs", () => {
	const services = resolveServices({
		postgres: { port: 5432 },
		search: service.custom({
			port: 7700,
			docker: {
				image: "getmeili/meilisearch:v1.10",
				volumes: [
					"search_data:/meili_data",
					"./fixtures:/fixtures:ro",
					"/scratch",
					"shared_cache:/cache",
				],
			},
		}),
	});
	const docker = {
		volumes: { search_data: {}, shared_cache: { external: true } },
	};

	it("mounts the stack's own volumes in memory and declares none", () => {
		const compose = buildComposeModel(services, docker, undefined, "docker", {
			data: "tmpfs",
		});

		expect(compose.services.postgres?.volumes).toBeUndefined();
		expect(compose.services.postgres?.tmpfs).toEqual([
			"/var/lib/postgresql/data",
		]);
		expect(compose.services.search?.volumes).toEqual([
			"./fixtures:/fixtures:ro",
			"shared_cache:/cache",
		]);
		expect(compose.services.search?.tmpfs).toEqual(["/meili_data", "/scratch"]);
		expect(compose.volumes).toEqual({ shared_cache: { external: true } });
	});

	it("runs on Apple container with --tmpfs and no volume", () => {
		const model = buildComposeModel(
			resolveServices({ postgres: { port: 5432 } }),
			undefined,
			undefined,
			"apple",
			{ data: "tmpfs" },
		);
		const [postgres] = buildAppleRunPlan({
			projectName: "demo-ci-1a2b3c",
			model,
			root: "/repo",
		}).services;

		const args = postgres?.runArgs ?? [];
		expect(args[args.indexOf("--tmpfs") + 1]).toBe("/var/lib/postgresql/data");
		expect(args).not.toContain("--volume");
		expect(postgres?.volumes).toEqual([]);
	});

	it("keeps named volumes by default", () => {
		const compose = buildComposeModel(services, docker);
		expect(compose.services.postgres?.volumes).toEqual([
			"postgres_data:/var/lib/postgresql/data",
		]);
		expect(compose.services.postgres?.tmpfs).toBeUndefined();
		expect(Object.keys(compose.volumes ?? {}).sort()).toEqual([
			"postgres_data",
			"search_data",
			"shared_cache",
		]);
	});
});

describe("composeToYaml", () => {
	it("serializes with deterministic key ordering", () => {
		const yaml = composeToYaml({
			services: {
				b: { image: "b" },
				a: { image: "a", environment: { Z_KEY: "z", A_KEY: "a" } },
			},
		});

		expect(yaml.indexOf("a:")).toBeLessThan(yaml.indexOf("b:"));
		expect(yaml.indexOf("A_KEY")).toBeLessThan(yaml.indexOf("Z_KEY"));
	});
});

describe("writeGeneratedComposeFile", () => {
	it("writes compose file and returns compose -f path", () => {
		const root = join(tmpdir(), `buncargo-compose-test-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		try {
			const composeFile = writeGeneratedComposeFile(
				root,
				resolveServices({
					postgres: { port: 5432 },
				}),
				{
					generatedFile: ".buncargo/docker-compose.generated.yml",
				},
			);

			expect(composeFile).toBe(".buncargo/docker-compose.generated.yml");
			expect(
				existsSync(join(root, ".buncargo/docker-compose.generated.yml")),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a different if-missing artifact without overwriting it", () => {
		const root = join(tmpdir(), `buncargo-compose-test-${Date.now()}-missing`);
		mkdirSync(root, { recursive: true });
		try {
			const filePath = join(root, ".buncargo/docker-compose.generated.yml");
			mkdirSync(join(root, ".buncargo"), { recursive: true });
			writeFileSync(filePath, "# custom\n", "utf-8");

			expect(() =>
				writeGeneratedComposeFile(
					root,
					resolveServices({
						postgres: { port: 5432 },
					}),
					{
						generatedFile: ".buncargo/docker-compose.generated.yml",
						writeStrategy: "if-missing",
					},
				),
			).toThrow("differs from the current config");

			const content = readFileSync(filePath, "utf-8");
			expect(content).toBe("# custom\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
