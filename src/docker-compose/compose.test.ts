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
import type { ServiceConfig } from "../types";
import {
	buildComposeModel,
	composeToYaml,
	writeGeneratedComposeFile,
} from "./index";
import { service } from "./services";

describe("buildComposeModel", () => {
	it("builds built-in postgres/redis/clickhouse services", () => {
		const services: Record<string, ServiceConfig> = {
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
		};

		const compose = buildComposeModel(services);

		expect(compose.services.postgres?.image).toBe("pgvector/pgvector:pg16");
		expect(compose.services.redis?.image).toBe("redis:7-alpine");
		expect(compose.services.clickhouse?.image).toBe(
			"clickhouse/clickhouse-server:24-alpine",
		);
		expect(compose.services.postgres?.ports).toEqual([
			"$" + "{POSTGRES_PORT:-5432}:5432",
		]);
		expect(compose.services.clickhouse?.ports).toEqual([
			"$" + "{CLICKHOUSE_PORT:-8123}:8123",
			"$" + "{CLICKHOUSESECONDARY_PORT:-9000}:9000",
		]);
		expect(compose.volumes).toEqual({
			postgres_data: {},
			clickhouse_data: {},
		});
		expect(compose.name).toBe("$" + "{COMPOSE_PROJECT_NAME}");
	});

	it("stamps identity labels when provided", () => {
		const compose = buildComposeModel({ postgres: { port: 5432 } }, undefined, {
			projectName: "gey-main",
			root: "/repo",
			worktree: "feature",
		});
		expect(compose.services.postgres?.labels).toEqual({
			"buncargo.project": "gey-main",
			"buncargo.root": "/repo",
			"buncargo.worktree": "feature",
			"buncargo.service": "postgres",
		});
	});

	it("supports helper and raw custom service definitions", () => {
		const services: Record<string, ServiceConfig> = {
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
		};

		const compose = buildComposeModel(services);

		expect(compose.services.postgres?.image).toBe("postgres:16-alpine");
		expect(compose.services.rabbitmq?.image).toBe(
			"rabbitmq:3-management-alpine",
		);
		expect(compose.services.nats?.ports).toEqual([
			"$" + "{NATS_PORT:-4222}:4222",
		]);
	});

	it("builds mailpit and typesense presets", () => {
		const compose = buildComposeModel({
			mailpit: service.mailpit(),
			typesense: service.typesense({ apiKey: "xyz" }),
		});

		expect(compose.services.mailpit?.image).toBe("axllent/mailpit");
		expect(compose.services.mailpit?.ports).toEqual([
			"$" + "{MAILPIT_PORT:-8025}:8025",
			"$" + "{MAILPITSECONDARY_PORT:-1025}:1025",
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
		const compose = buildComposeModel({
			postgres: service.postgres({ healthCheck: "tcp" }),
			redis: service.redis({ healthCheck: "tcp" }),
		});

		expect(compose.services.postgres?.healthcheck).toBeUndefined();
		expect(compose.services.redis?.healthcheck).toBeUndefined();
	});

	it("normalizes raw built-in service as inferred preset override", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: {
				port: 5432,
				docker: {
					image: "postgres:16-alpine",
				},
			},
		};

		const compose = buildComposeModel(services);
		expect(compose.services.postgres?.image).toBe("postgres:16-alpine");
		expect(compose.services.postgres?.ports).toEqual([
			"$" + "{POSTGRES_PORT:-5432}:5432",
		]);
		expect(compose.services.postgres?.environment).toEqual({
			POSTGRES_USER: "postgres",
			POSTGRES_PASSWORD: "postgres",
			POSTGRES_DB: "postgres",
		});
		expect(compose.volumes).toEqual({ postgres_data: {} });
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
				{
					postgres: { port: 5432 },
				},
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

	it("respects if-missing write strategy", () => {
		const root = join(tmpdir(), `buncargo-compose-test-${Date.now()}-missing`);
		mkdirSync(root, { recursive: true });
		try {
			const filePath = join(root, ".buncargo/docker-compose.generated.yml");
			mkdirSync(join(root, ".buncargo"), { recursive: true });
			writeFileSync(filePath, "# custom\n", "utf-8");

			writeGeneratedComposeFile(
				root,
				{
					postgres: { port: 5432 },
				},
				{
					generatedFile: ".buncargo/docker-compose.generated.yml",
					writeStrategy: "if-missing",
				},
			);

			const content = readFileSync(filePath, "utf-8");
			expect(content).toBe("# custom\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
