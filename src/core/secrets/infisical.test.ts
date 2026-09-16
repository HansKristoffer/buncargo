import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../types";
import {
	applySecretDefaults,
	clearScopeSecretsCache,
	loadAppSecrets,
	resolveScope,
} from "./infisical";

const dirs: string[] = [];
const saved = {
	home: process.env.HOME,
	path: process.env.BUNCARGO_INFISICAL_PATH,
};

/** A stand-in CLI that records every invocation, so "one fetch" is observable. */
function fakeInfisical(body: string): { calls: () => string[] } {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-secrets-"));
	dirs.push(dir);
	const log = join(dir, "calls.log");
	const binary = join(dir, "infisical");
	writeFileSync(
		binary,
		`#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n${body}\n`,
	);
	chmodSync(binary, 0o755);
	process.env.HOME = dir;
	process.env.BUNCARGO_INFISICAL_PATH = binary;
	return {
		calls: () => {
			try {
				return readFileSync(log, "utf-8").trim().split("\n");
			} catch {
				return [];
			}
		},
	};
}

function app(projectId: string): AppConfig {
	return { port: 3000, devCommand: "true", secrets: { projectId } };
}

afterEach(() => {
	clearScopeSecretsCache();
	for (const key of ["HOME", "BUNCARGO_INFISICAL_PATH"] as const) {
		const value = key === "HOME" ? saved.home : saved.path;
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("resolveScope", () => {
	it("fills every field from the app, then the defaults, then the env", () => {
		expect(
			resolveScope({ projectId: "p1" }, { environment: "staging" }, {}),
		).toEqual({
			projectId: "p1",
			environment: "staging",
			siteUrl: "https://app.infisical.com",
			path: "/",
		});
		expect(
			resolveScope({ projectId: "p1" }, undefined, { SECRETS_ENV: "qa" })
				?.environment,
		).toBe("qa");
		expect(resolveScope(undefined, undefined, {})).toBeUndefined();
	});
});

describe("applySecretDefaults", () => {
	it("resolves each opted-in app's scope and leaves the rest alone", () => {
		const apps = {
			api: app("p1"),
			plain: { port: 3001, devCommand: "true" } as AppConfig,
		};
		const resolved = applySecretDefaults(
			apps,
			{ siteUrl: "https://eu.infisical.com" },
			{},
		);
		expect(resolved.api.secrets).toEqual({
			projectId: "p1",
			environment: "dev",
			siteUrl: "https://eu.infisical.com",
			path: "/",
		});
		expect(resolved.plain).toBe(apps.plain);
	});

	it("returns the same object when no app opted in", () => {
		const apps = { api: { port: 3000, devCommand: "true" } as AppConfig };
		expect(applySecretDefaults(apps, { projectId: "p1" }, {})).toBe(apps);
	});
});

describe("loadAppSecrets", () => {
	it("spawns nothing when no app declares a scope", async () => {
		const cli = fakeInfisical('echo "[]"');
		expect(
			await loadAppSecrets(
				{ api: { port: 3000, devCommand: "true" } },
				{
					projectId: "p1",
				},
			),
		).toEqual({});
		expect(cli.calls()).toEqual([]);
	});

	it("fetches a shared scope once for every app that uses it", async () => {
		const cli = fakeInfisical(
			`echo '[{"key":"OPENAI_API_KEY","value":"sk-project"}]'`,
		);
		const secrets = await loadAppSecrets(
			{ web: app("shared"), marketing: app("shared"), api: app("other") },
			undefined,
			{ env: {} },
		);
		expect(secrets.web).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(secrets.marketing).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(secrets.api).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(cli.calls()).toHaveLength(2);
	});

	it("keeps the developer's own exported value", async () => {
		fakeInfisical(`echo '[{"key":"OPENAI_API_KEY","value":"sk-project"}]'`);
		const secrets = await loadAppSecrets({ api: app("p1") }, undefined, {
			env: { OPENAI_API_KEY: "sk-local" },
		});
		expect(secrets.api).toEqual({});
	});

	it("leaves an empty exported value out", async () => {
		fakeInfisical(
			`echo '[{"key":"FILLED","value":"x"},{"key":"BLANK","value":""}]'`,
		);
		expect(
			await loadAppSecrets({ api: app("p1") }, undefined, { env: {} }),
		).toEqual({ api: { FILLED: "x" } });
	});

	it("leaves a machine identity to the app's own loader", async () => {
		const cli = fakeInfisical(`echo '[{"key":"K","value":"v"}]'`);
		expect(
			await loadAppSecrets({ api: app("p1") }, undefined, {
				env: {
					INFISICAL_CLIENT_ID: "id",
					INFISICAL_CLIENT_SECRET: "secret",
				},
			}),
		).toEqual({});
		expect(cli.calls()).toEqual([]);
	});

	it("warns and yields nothing when the CLI fails", async () => {
		fakeInfisical("exit 1");
		const warnings: unknown[] = [];
		const warn = console.warn;
		console.warn = (message: unknown) => warnings.push(message);
		try {
			expect(
				await loadAppSecrets({ api: app("p1") }, undefined, { env: {} }),
			).toEqual({ api: {} });
		} finally {
			console.warn = warn;
		}
		expect(String(warnings[0])).toContain("api");
	});
});
