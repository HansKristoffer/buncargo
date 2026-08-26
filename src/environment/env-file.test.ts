import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../types";
import {
	buildEnvFileUpdates,
	isReplaceableEnvValue,
	resolveEnvFileOptions,
	rewriteEnvValues,
	syncEnvFile,
} from "./env-file";

describe("isReplaceableEnvValue", () => {
	it("accepts an unset value", () => {
		expect(isReplaceableEnvValue("")).toBe(true);
		expect(isReplaceableEnvValue("   ")).toBe(true);
	});

	it("accepts a bare port", () => {
		expect(isReplaceableEnvValue("5432")).toBe(true);
	});

	it("accepts an address already on loopback", () => {
		expect(isReplaceableEnvValue("http://localhost:3000")).toBe(true);
		expect(isReplaceableEnvValue("http://127.0.0.1:3000/api")).toBe(true);
		expect(
			isReplaceableEnvValue("postgresql://user:pw@localhost:5432/db"),
		).toBe(true);
		expect(isReplaceableEnvValue('"http://localhost:3000"')).toBe(true);
	});

	// A cloned remote database or a shared staging service is someone's
	// deliberate choice and must survive.
	it("protects a remote address", () => {
		expect(
			isReplaceableEnvValue("postgresql://user:pw@db.example.com:5432/db"),
		).toBe(false);
		expect(isReplaceableEnvValue("https://api.staging.example.com")).toBe(
			false,
		);
	});

	it("protects an opaque value", () => {
		expect(isReplaceableEnvValue("sk_live_abc123")).toBe(false);
	});
});

describe("rewriteEnvValues", () => {
	it("rewrites only replaceable values", () => {
		const { contents, changed } = rewriteEnvValues(
			"A=\nB=http://localhost:1\nC=https://remote.example.com\n",
			{
				A: "http://localhost:9",
				B: "http://localhost:9",
				C: "http://localhost:9",
			},
		);
		expect(contents).toBe(
			"A=http://localhost:9\nB=http://localhost:9\nC=https://remote.example.com\n",
		);
		expect(changed).toEqual(["A", "B"]);
	});

	it("never adds a key that is absent", () => {
		const { contents, changed } = rewriteEnvValues("A=\n", {
			A: "1",
			MISSING: "2",
		});
		expect(contents).toBe("A=1\n");
		expect(changed).toEqual(["A"]);
	});

	it("preserves comments, blank lines and ordering", () => {
		const original = [
			"# database",
			"",
			"DATABASE_URL=",
			"# keep me",
			"OTHER=untouched",
			"",
		].join("\n");

		const { contents } = rewriteEnvValues(original, {
			DATABASE_URL: "postgresql://localhost:7332/db",
		});

		expect(contents).toBe(
			[
				"# database",
				"",
				"DATABASE_URL=postgresql://localhost:7332/db",
				"# keep me",
				"OTHER=untouched",
				"",
			].join("\n"),
		);
	});

	it("keeps an export prefix and the spacing around the equals sign", () => {
		expect(
			rewriteEnvValues("export  API_PORT = 1\n", { API_PORT: "2" }).contents,
		).toBe("export  API_PORT = 2\n");
	});

	// `\s` in the value group would swallow the newline and pull the next line up.
	it("does not fold the next line into an empty value", () => {
		const { contents } = rewriteEnvValues("A=\nB=keep\n", { A: "1" });
		expect(contents).toBe("A=1\nB=keep\n");
	});

	it("round-trips a file with no trailing newline", () => {
		expect(rewriteEnvValues("A=", { A: "1" }).contents).toBe("A=1");
	});

	it("reports no change when the value already matches", () => {
		expect(rewriteEnvValues("A=1\n", { A: "1" }).changed).toEqual([]);
	});
});

describe("resolveEnvFileOptions", () => {
	it("is off unless asked for", () => {
		expect(resolveEnvFileOptions(undefined)).toBeUndefined();
		expect(resolveEnvFileOptions(false)).toBeUndefined();
	});

	it("defaults true to .env", () => {
		expect(resolveEnvFileOptions(true)?.path).toBe(".env");
	});

	it("keeps an explicit path and template", () => {
		expect(
			resolveEnvFileOptions({
				path: "apps/api/.env",
				createFrom: ".env.example",
			}),
		).toEqual({ path: "apps/api/.env", createFrom: ".env.example" });
	});
});

describe("buildEnvFileUpdates", () => {
	const services: Record<string, ServiceConfig> = {
		postgres: { port: 5432, database: "app" },
	};

	it("derives ports and loopback URLs, including service aliases", () => {
		const updates = buildEnvFileUpdates({
			projectName: "app-app",
			services,
			ports: { postgres: 7332, api: 4900 },
			loopbackUrls: {
				postgres: "postgresql://postgres:postgres@localhost:7332/app",
				api: "http://localhost:4900",
			},
		});

		expect(updates.POSTGRES_PORT).toBe("7332");
		expect(updates.API_PORT).toBe("4900");
		expect(updates.API_URL).toBe("http://localhost:4900");
		expect(updates.API_LOOPBACK_URL).toBe("http://localhost:4900");
		expect(updates.DATABASE_URL).toBe(
			"postgresql://postgres:postgres@localhost:7332/app",
		);
	});

	// The point of the file is tooling that cannot use the local CA.
	it("never emits a named HTTPS host", () => {
		const updates = buildEnvFileUpdates({
			projectName: "app-app",
			services: {},
			ports: { web: 4901 },
			loopbackUrls: { web: "http://localhost:4901" },
		});
		expect(updates.WEB_URL).toBe("http://localhost:4901");
	});

	it("adds repo-declared keys buncargo cannot derive", () => {
		const updates = buildEnvFileUpdates({
			projectName: "app-app",
			services,
			ports: { postgres: 7332, api: 4900 },
			loopbackUrls: {
				postgres: "postgresql://postgres:postgres@localhost:7332/app",
				api: "http://localhost:4900",
			},
			values: (ports, loopbackUrls) => ({
				DATABASE_URL_PGBOUNCER: loopbackUrls.postgres,
				API_URL: `${loopbackUrls.api}/api`,
				DEBUG_PORT: ports.api,
				OMITTED: undefined,
			}),
		});
		expect(updates.DATABASE_URL_PGBOUNCER).toBe(
			"postgresql://postgres:postgres@localhost:7332/app",
		);
		expect(updates.API_URL).toBe("http://localhost:4900/api");
		expect(updates.DEBUG_PORT).toBe("4900");
		expect(updates).not.toHaveProperty("OMITTED");
	});

	// So a repo can correct a derived name rather than only add alongside it.
	it("lets a declared key override a computed one", () => {
		const updates = buildEnvFileUpdates({
			projectName: "app-app",
			services: {},
			ports: { api: 4900 },
			loopbackUrls: { api: "http://localhost:4900" },
			values: (_ports, loopbackUrls) => ({
				API_URL: `${loopbackUrls.api}/api`,
			}),
		});
		expect(updates.API_URL).toBe("http://localhost:4900/api");
	});
});

describe("syncEnvFile", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "buncargo-envfile-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const base = {
		projectName: "app-app",
		services: {} as Record<string, ServiceConfig>,
		ports: { api: 4900 },
		loopbackUrls: { api: "http://localhost:4900" },
	};

	it("does nothing when not configured", async () => {
		expect(
			await syncEnvFile({ ...base, root, envFile: undefined }),
		).toBeUndefined();
	});

	it("rewrites a stale port in place", async () => {
		writeFileSync(join(root, ".env"), "# api\nAPI_URL=http://localhost:1\n");

		const result = await syncEnvFile({ ...base, root, envFile: true });

		expect(result?.changed).toContain("API_URL");
		expect(readFileSync(join(root, ".env"), "utf-8")).toBe(
			"# api\nAPI_URL=http://localhost:4900\n",
		);
	});

	// The file is the repo's contract, so buncargo must not invent one.
	it("reports an absent file rather than creating it", async () => {
		const result = await syncEnvFile({ ...base, root, envFile: true });

		expect(result?.absent).toBe(true);
		expect(result?.created).toBe(false);
	});

	it("bootstraps from createFrom when the file is missing", async () => {
		writeFileSync(join(root, ".env.example"), "API_URL=\n");

		const result = await syncEnvFile({
			...base,
			root,
			envFile: { createFrom: ".env.example" },
		});

		expect(result?.created).toBe(true);
		expect(readFileSync(join(root, ".env"), "utf-8")).toBe(
			"API_URL=http://localhost:4900\n",
		);
	});

	it("honors an explicit path", async () => {
		writeFileSync(join(root, "custom.env"), "API_URL=\n");

		const result = await syncEnvFile({
			...base,
			root,
			envFile: { path: "custom.env" },
		});

		expect(result?.path).toBe(join(root, "custom.env"));
		expect(readFileSync(join(root, "custom.env"), "utf-8")).toBe(
			"API_URL=http://localhost:4900\n",
		);
	});

	it("leaves no temp file behind", async () => {
		writeFileSync(join(root, ".env"), "API_URL=\n");
		await syncEnvFile({ ...base, root, envFile: true });

		expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual(
			[],
		);
	});
});
