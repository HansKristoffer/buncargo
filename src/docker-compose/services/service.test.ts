import { describe, expect, it } from "bun:test";
import { defineDevConfig, validateConfig } from "../../config";
import { resolveServices } from "../../config/resolve";
import { buildSharedEnvValues, stringifyEnvValues } from "../../core/env";
import { computeUrls } from "../../core/ports";
import { DOCKER_PRESET_NAMES } from "../../core/service-presets";
import type { DockerPresetName, ServiceConfig } from "../../types";
import {
	canProveServiceInputs,
	interpolate,
	serviceFingerprint,
} from "../interpolate";
import { buildComposeModel } from "../model";
import { service } from ".";

const IDENTITY = { projectName: "app-main", root: "/repo", worktree: null };

/** The model and the environment a run hands the backend for these services. */
function render(declared: Record<string, ServiceConfig>) {
	const services = resolveServices(declared);
	const ports: Record<string, number> = {};
	for (const [key, config] of Object.entries(services)) {
		if (config.port !== undefined) ports[key] = config.port + 10;
		if (config.secondaryPort !== undefined) {
			ports[`${key}Secondary`] = config.secondaryPort + 10;
		}
	}

	const urls = computeUrls(services, {}, ports, "127.0.0.1");
	const env = stringifyEnvValues(
		buildSharedEnvValues({
			projectName: IDENTITY.projectName,
			services,
			ports,
			urls,
			publicUrls: {},
		}),
	);

	return { model: buildComposeModel(services, undefined, IDENTITY), env };
}

describe("preset Compose models", () => {
	// One service that cannot be proven unchanged makes every warm start run
	// `compose up` over the whole stack.
	it.each([...DOCKER_PRESET_NAMES])(
		"proves %s unchanged on a second render, under its own key or another",
		(preset) => {
			for (const key of [preset, "store"]) {
				const services = { [key]: service[preset]() };
				const first = render(services);
				const second = render(services);

				expect(canProveServiceInputs(first.model, key, first.env)).toBe(true);
				expect(serviceFingerprint(second.model, key, second.env)).toBe(
					serviceFingerprint(first.model, key, first.env),
				);
			}
		},
	);

	it("binds a hyphenated key's port to a variable Compose can read", () => {
		const { model, env } = render({ "my-db": service.postgres() });
		const [binding] = model.services["my-db"]?.ports ?? [];

		expect(interpolate(String(binding), env)).toBe("127.0.0.1:5442:5432");
	});

	it("publishes ports on loopback only, unless the service sets bind", () => {
		const { model, env } = render({
			db: service.postgres(),
			analytics: service.clickhouse({ bind: "0.0.0.0" }),
			queue: { port: 5672, bind: "::", docker: { image: "rabbitmq:3" } },
		});
		const published = (key: string) =>
			(model.services[key]?.ports ?? []).map((spec) =>
				interpolate(String(spec), env),
			);

		expect(published("db")).toEqual(["127.0.0.1:5442:5432"]);
		expect(published("analytics")).toEqual([
			"0.0.0.0:8133:8123",
			"0.0.0.0:9010:9000",
		]);
		expect(published("queue")).toEqual(["[::]:5682:5672"]);
	});

	it("hands Compose a typed password with its $ escaped, so it arrives as typed", () => {
		const { model, env } = render({
			db: service.postgres({ password: "pa$word", user: "u$er" }),
			search: service.typesense({ apiKey: "k$y" }),
		});
		const postgres = model.services.db;
		const environment = postgres?.environment as Record<string, string>;

		expect(postgres?.environment).toMatchObject({
			POSTGRES_PASSWORD: "pa$$word",
			POSTGRES_USER: "u$$er",
		});
		expect(interpolate(environment.POSTGRES_PASSWORD ?? "", env)).toBe(
			"pa$word",
		);

		const command = String(model.services.search?.command);
		expect(interpolate(command, {})).toContain("--api-key=k$y ");
	});

	it("appends urlParams to Postgres connection URLs", () => {
		const { env } = render({
			postgres: service.postgres({
				database: "translations_dev",
				urlParams: { sslmode: "disable", connect_timeout: "5" },
			}),
		});
		expect(env.DATABASE_URL).toBe(
			"postgresql://postgres:postgres@localhost:5442/translations_dev?sslmode=disable&connect_timeout=5",
		);

		const wrongService = validateConfig({
			projectPrefix: "db",
			services: {
				redis: {
					...service.redis(),
					urlParams: { sslmode: "disable" },
				},
			},
		});
		expect(wrongService).toEqual([
			expect.stringContaining('Service "redis" sets urlParams'),
		]);
	});
});

describe("minio and job helpers", () => {
	it("serves MinIO on its own port 9000 whatever host port the config picks", () => {
		const { model, env } = render({ storage: service.minio({ port: 9100 }) });
		const [binding] = model.services.storage?.ports ?? [];

		expect(interpolate(String(binding), env)).toBe("127.0.0.1:9110:9000");
		expect(env.MINIO_URL).toBe("http://localhost:9110");
	});

	it("hands MinIO the credentials it gives the apps, with $ escaped for Compose", () => {
		const minio = service.minio({ user: "app", password: "pa$sword" });

		expect(minio.staticEnv).toEqual({
			MINIO_ROOT_USER: "app",
			MINIO_ROOT_PASSWORD: "pa$sword",
		});
		const { model, env } = render({ minio });
		const environment = model.services.minio?.environment as Record<
			string,
			string
		>;
		expect(interpolate(environment.MINIO_ROOT_PASSWORD ?? "", env)).toBe(
			"pa$sword",
		);
	});

	it("keeps MinIO's Compose healthcheck, which jobs wait on, unless it is turned off", () => {
		expect(
			render({ minio: service.minio() }).model.services.minio?.healthcheck,
		).toBeDefined();

		const off = render({ minio: service.minio({ healthCheck: false }) });
		expect(off.model.services.minio?.healthcheck).toBeUndefined();
	});

	it("accepts and normalizes minio buckets with optional policies", () => {
		const config = defineDevConfig({
			projectPrefix: "storage",
			services: {
				minio: service.minio({
					buckets: ["brain", { name: "uploads", policy: "download" }],
				}),
			},
		});
		expect(validateConfig(config)).toEqual([]);
		const resolved = resolveServices(config.services);
		expect(resolved.minio.buckets).toEqual([
			{ name: "brain" },
			{ name: "uploads", policy: "download" },
		]);

		const invalidShape = validateConfig({
			projectPrefix: "storage",
			services: {
				minio: {
					...service.minio(),
					buckets: [
						{ name: "", policy: "invalid" as never },
						{ policy: "download" } as never,
					],
				},
			},
		});
		expect(invalidShape).toEqual(
			expect.arrayContaining([
				expect.stringContaining("buckets[0].name"),
				expect.stringContaining("buckets[0].policy"),
				expect.stringContaining("buckets[1].name is required"),
			]),
		);

		const wrongService = validateConfig({
			projectPrefix: "storage",
			services: {
				postgres: {
					...service.postgres(),
					buckets: ["oops"],
				},
			},
		});
		expect(wrongService).toEqual([
			expect.stringContaining('Service "postgres" sets buckets'),
		]);
	});

	it("sets subdirectory PGDATA automatically for Postgres 18+ images while leaving pg16/17 intact", () => {
		const pg16 = render({ postgres: service.postgres() });
		expect(
			(pg16.model.services.postgres?.environment as Record<string, string>)
				.PGDATA,
		).toBeUndefined();

		const pg17 = render({
			postgres: service.postgres({ docker: { image: "postgres:17-alpine" } }),
		});
		expect(
			(pg17.model.services.postgres?.environment as Record<string, string>)
				.PGDATA,
		).toBeUndefined();

		const pg18 = render({
			postgres: service.postgres({ docker: { image: "postgres:18" } }),
		});
		expect(
			(pg18.model.services.postgres?.environment as Record<string, string>)
				.PGDATA,
		).toBe("/var/lib/postgresql/data/pgdata");

		const pgvector18 = render({
			postgres: service.postgres({
				docker: { image: "pgvector/pgvector:pg18" },
			}),
		});
		expect(
			(
				pgvector18.model.services.postgres?.environment as Record<
					string,
					string
				>
			).PGDATA,
		).toBe("/var/lib/postgresql/data/pgdata");

		const explicit = render({
			postgres: service.postgres({
				docker: {
					image: "postgres:18",
					environment: { PGDATA: "/custom/pgdata" },
				},
			}),
		});
		expect(
			(explicit.model.services.postgres?.environment as Record<string, string>)
				.PGDATA,
		).toBe("/custom/pgdata");
	});

	it("builds a job a config accepts and a warm start can prove unchanged", () => {
		// A helper function returning a job is where hand-written ones needed
		// `as const`: the literal widened to `kind: string`.
		const mc = (args: string[]) =>
			service.job({
				docker: {
					image:
						"cgr.dev/chainguard/minio-client@sha256:799a60aa839c0d79b53f1dccdddc974d0fe94282cca712fbfbad3b196f88d0ee",
					command: args,
					depends_on: { minio: { condition: "service_healthy" } },
				},
			});
		const config = defineDevConfig({
			projectPrefix: "jobs",
			services: { minio: service.minio(), bucket: mc(["mb", "local/app"]) },
		});
		const kind: "job" = config.services.bucket.kind;

		expect(kind).toBe("job");
		expect(validateConfig(config)).toEqual([]);

		const { model, env } = render(config.services);

		expect(model.services.bucket?.restart).toBe("no");
		expect(canProveServiceInputs(model, "bucket", env)).toBe(true);

		// @ts-expect-error - a job publishes no port
		service.job({ port: 1, docker: { image: "busybox:1" } });
	});
});

describe("service helpers", () => {
	it("builds postgres with defaults", () => {
		const cfg = service.postgres();
		expect(cfg.port).toBe(5432);
		expect(cfg.healthCheck).toBe("pg_isready");
		expect(cfg.docker).toEqual({
			kind: "preset",
			preset: "postgres",
			service: undefined,
		});
	});

	it("builds redis with defaults", () => {
		const cfg = service.redis();
		expect(cfg.port).toBe(6379);
		expect(cfg.healthCheck).toBe("redis-cli");
		expect(cfg.docker).toEqual({
			kind: "preset",
			preset: "redis",
			service: undefined,
		});
	});

	it("builds clickhouse with defaults", () => {
		const cfg = service.clickhouse();
		expect(cfg.port).toBe(8123);
		expect(cfg.secondaryPort).toBe(9000);
		expect(cfg.healthCheck).toBe("http");
		expect(cfg.docker).toEqual({
			kind: "preset",
			preset: "clickhouse",
			service: undefined,
		});
	});

	it("builds mailpit with a secondary SMTP port", () => {
		const cfg = service.mailpit();
		expect(cfg.port).toBe(8025);
		expect(cfg.secondaryPort).toBe(1025);
		expect(cfg.healthCheck).toBe(false);
		expect(cfg.staticEnv).toEqual({ SMTP_HOST: "localhost" });
		expect(cfg.docker).toEqual({
			kind: "preset",
			preset: "mailpit",
			service: undefined,
		});
	});

	it("builds typesense with a default API key", () => {
		const cfg = service.typesense();
		expect(cfg.port).toBe(8108);
		// The image has no wget/curl, so an in-container probe can never pass.
		expect(cfg.healthCheck).toBe("tcp");
		expect(cfg.staticEnv).toEqual({ TYPESENSE_API_KEY: "xyz" });
		expect(service.typesense({ apiKey: "secret" }).staticEnv).toEqual({
			TYPESENSE_API_KEY: "secret",
		});
	});

	it("supports custom service pass-through", () => {
		const cfg = service.custom({
			port: 4222,
			healthCheck: false,
			docker: {
				image: "nats:2-alpine",
				ports: ["$" + "{NATS_PORT:-4222}:4222"],
			},
		});

		expect(cfg.port).toBe(4222);
		expect(cfg.healthCheck).toBe(false);
		expect(cfg.docker).toEqual({
			image: "nats:2-alpine",
			ports: ["$" + "{NATS_PORT:-4222}:4222"],
		});
	});

	it("passes through expose option on helper services", () => {
		const postgres = service.postgres({ expose: true });
		const redis = service.redis({ expose: true });

		expect(postgres.expose).toBe(true);
		expect(redis.expose).toBe(true);
	});

	it("only accepts credentials on presets whose URL carries them", () => {
		expect(service.postgres({ database: "app", user: "app" }).database).toBe(
			"app",
		);
		// @ts-expect-error - redis:// carries no credentials
		expect(service.redis({ database: "app" }).database).toBeUndefined();
		// @ts-expect-error - mailpit has no credentials either
		expect(service.mailpit({ user: "app" }).user).toBeUndefined();
	});

	it("narrows docker definitions on the kind discriminant", () => {
		const preset = service.postgres().docker;
		const raw = service.custom({
			port: 4222,
			docker: { image: "nats:2-alpine" },
		}).docker;

		if (preset?.kind === "preset") {
			const presetName: DockerPresetName = preset.preset;
			expect(presetName).toBe("postgres");
		} else {
			throw new Error("expected a preset definition");
		}

		if (raw?.kind === "preset") {
			throw new Error("expected a raw definition");
		}

		const image: string | undefined = raw?.image;
		expect(image).toBe("nats:2-alpine");
	});
});
