// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixture strings exercise Compose interpolation.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposeDocument } from "../types";
import { writeGeneratedComposeFile } from "./generated-file";
import {
	canProveServiceUnchanged,
	configHashFor,
	SERVICE_HASH_LABEL,
	STACK_HASH_LABEL,
	serviceFingerprint,
} from "./interpolate";

describe("resolved container artifact", () => {
	const model: ComposeDocument = {
		services: {
			db: {
				image: "postgres:16",
				volumes: ["data:/db"],
				environment: { MODE: "${APP_MODE}" },
			},
		},
		volumes: { data: { driver: "local" }, unrelated: {} },
	};
	it("includes ambient interpolation and referenced volume definitions", () => {
		const hash = serviceFingerprint(model, "db", { APP_MODE: "one" });
		expect(serviceFingerprint(model, "db", { APP_MODE: "two" })).not.toBe(hash);
		expect(
			serviceFingerprint(
				{ ...model, volumes: { data: { driver: "other" } } },
				"db",
				{ APP_MODE: "one" },
			),
		).not.toBe(hash);
		expect(
			serviceFingerprint(
				{
					...model,
					services: { ...model.services, cache: { image: "redis:7" } },
					volumes: { ...model.volumes, unrelated: { driver: "other" } },
				},
				"db",
				{ APP_MODE: "one" },
			),
		).toBe(hash);
	});
	it("ignores only hash metadata and preserves user label changes", () => {
		expect(
			configHashFor({
				image: "redis",
				labels: {
					[SERVICE_HASH_LABEL]: "one",
					[STACK_HASH_LABEL]: "old",
					team: "a",
				},
			}),
		).toBe(
			configHashFor({
				image: "redis",
				labels: {
					[SERVICE_HASH_LABEL]: "two",
					[STACK_HASH_LABEL]: "new",
					team: "a",
				},
			}),
		);
		expect(configHashFor({ image: "redis", labels: { team: "a" } })).not.toBe(
			configHashFor({ image: "redis", labels: { team: "b" } }),
		);
	});
	it("conservatively reconciles external build and environment inputs", () => {
		expect(canProveServiceUnchanged({ image: "redis:7" })).toBe(true);
		for (const key of [
			"build",
			"env_file",
			"configs",
			"secrets",
			"label_file",
			"extends",
		])
			expect(
				canProveServiceUnchanged({ image: "redis", [key]: "external" }),
			).toBe(false);
	});
	it("keeps unchanged YAML inode and publishes private complete content", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo artifact "));
		try {
			const services = { postgres: { port: 5432 } };
			const path = join(root, writeGeneratedComposeFile(root, services));
			const before = statSync(path);
			const content = readFileSync(path, "utf8");
			writeGeneratedComposeFile(root, services);
			expect(statSync(path).ino).toBe(before.ino);
			expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			writeGeneratedComposeFile(root, { postgres: { port: 6432 } });
			expect(readFileSync(path, "utf8")).not.toBe(content);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("complete artifact proof", () => {
	it("preserves list-form user labels when stamping runtime identity", async () => {
		const { buildComposeModel } = await import("./model");
		const model = buildComposeModel(
			{
				custom: {
					port: 8888,
					docker: {
						image: "custom:v1",
						labels: ["team=platform", "empty", "value=a=b"],
					},
				},
			},
			undefined,
			{ root: "/repo", projectName: "demo" },
		);
		const { normalizeComposeLabels } = await import("./interpolate");
		expect(normalizeComposeLabels(model.services.custom?.labels)).toMatchObject(
			{
				team: "platform",
				empty: "",
				value: "a=b",
				"buncargo.project": "demo",
			},
		);
		expect(Array.isArray(model.services.custom?.labels)).toBe(true);
	});
	it("refuses incomplete volume interpolation and unsupported nested/alternate syntax", async () => {
		const { canProveServiceInputs } = await import("./interpolate");
		const model: ComposeDocument = {
			services: { db: { image: "postgres:16", volumes: ["data:/db"] } },
			volumes: { data: { driver_opts: { device: "${EXTERNAL_VOLUME}" } } },
		};
		expect(canProveServiceInputs(model, "db", {})).toBe(false);
		expect(
			canProveServiceInputs(model, "db", { EXTERNAL_VOLUME: "/data" }),
		).toBe(true);
		for (const value of [
			"${OUTER:+${INNER}}",
			"${OUTER:-${INNER}}",
			"${OUTER:+yes}",
		]) {
			expect(
				canProveServiceInputs(
					{
						services: {
							db: { image: "postgres:16", environment: { VALUE: value } },
						},
					},
					"db",
					{ OUTER: "set", INNER: "set" },
				),
			).toBe(false);
		}
		expect(
			canProveServiceInputs(
				{ services: { db: { image: "postgres:16", command: "echo $$HOME" } } },
				"db",
				{},
			),
		).toBe(true);
	});
	it("lets the backend honor image refresh policies", () => {
		for (const service of [
			{ image: "redis:7", pull_policy: "always" },
			{ image: "redis:latest" },
			{ image: "registry:5000/redis" },
		])
			expect(canProveServiceUnchanged(service)).toBe(false);
		expect(canProveServiceUnchanged({ image: "redis@sha256:abc" })).toBe(true);
		expect(
			canProveServiceUnchanged({ image: "redis:latest", pull_policy: "never" }),
		).toBe(true);
	});
});
