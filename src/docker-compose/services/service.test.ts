import { describe, expect, it } from "bun:test";
import type { DockerPresetName } from "../../types";
import { service } from ".";

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
		expect(cfg.healthCheck).toBe("http");
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
