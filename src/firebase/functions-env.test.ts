import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUNCARGO_FUNCTIONS_ENV_HEADER,
	isReservedFunctionsEnvKey,
	isValidFunctionsEnvKey,
	renderFunctionsEnvFile,
	resolveFunctionsSourceDir,
	serializeFunctionsEnvEntry,
	writeFunctionsEnvFile,
} from "./functions-env";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("functionsEnv rendering", () => {
	it("filters Firebase reserved keys, invalid names, wildcards, and credentials", () => {
		expect(isReservedFunctionsEnvKey("GCLOUD_PROJECT")).toBe(true);
		expect(isReservedFunctionsEnvKey("FIREBASE_CONFIG")).toBe(true);
		expect(isReservedFunctionsEnvKey("X_GOOGLE_FOO")).toBe(true);
		expect(isReservedFunctionsEnvKey("EXT_BAR")).toBe(true);
		expect(isReservedFunctionsEnvKey("PORT")).toBe(true);
		expect(isReservedFunctionsEnvKey("UNLEASH_TOKEN")).toBe(false);

		expect(isValidFunctionsEnvKey("VALID_KEY_1")).toBe(true);
		expect(isValidFunctionsEnvKey("bad-key")).toBe(false);
		expect(isValidFunctionsEnvKey("1STARTS_WITH_NUM")).toBe(false);

		const rendered = renderFunctionsEnvFile(
			{
				GCLOUD_PROJECT: "kanpla-46f43",
				FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
				PORT: "5001",
				FB_PRIVATE_KEY_DEV: "-----BEGIN-----\nsecret\n-----END-----",
				GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
				"bad-name": "nope",
				UNLEASH_URL: "https://unleash.example.com",
				JSON_CONFIG: '{"projectId":"demo-kanpla"}',
			},
			{ exclude: ["FB_PRIVATE_KEY_*"], isolateCredentials: true },
		);

		expect(rendered.writtenKeys).toEqual(["JSON_CONFIG", "UNLEASH_URL"]);
		expect(rendered.skippedKeys).toEqual([
			"bad-name",
			"FB_PRIVATE_KEY_DEV",
			"FIREBASE_AUTH_EMULATOR_HOST",
			"GCLOUD_PROJECT",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"PORT",
		]);
		expect(rendered.content).toBe(
			[
				BUNCARGO_FUNCTIONS_ENV_HEADER,
				`JSON_CONFIG='{"projectId":"demo-kanpla"}'`,
				`UNLEASH_URL='https://unleash.example.com'`,
				"",
			].join("\n"),
		);
	});

	it("serializes multiline, double-quoted, and single-quoted values safely", () => {
		expect(serializeFunctionsEnvEntry("PEM", "line1\nline2")).toBe(
			"PEM='line1\nline2'",
		);
		expect(serializeFunctionsEnvEntry("QUOTE", "it's\nfine")).toBe(
			'QUOTE="it\'s\\nfine"',
		);
		expect(serializeFunctionsEnvEntry("BOTH", `a'b"c\\d`)).toBe(
			'BOTH="a\'b\\"c\\\\d"',
		);
	});

	it("resolves functions.source from object, array, or default", () => {
		expect(
			resolveFunctionsSourceDir({
				functions: { source: "dist/apps/functions" },
			}),
		).toBe("dist/apps/functions");
		expect(
			resolveFunctionsSourceDir({
				functions: [{ source: "packages/fn" }],
			}),
		).toBe("packages/fn");
		expect(resolveFunctionsSourceDir({})).toBe("functions");
	});
});

describe("writeFunctionsEnvFile", () => {
	it("writes with 0o600 permissions and removes generated file on restore", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-fn-env-"));
		dirs.push(dir);
		const target = join(dir, "dist", "functions", ".env");

		const handle = writeFunctionsEnvFile(
			target,
			`${BUNCARGO_FUNCTIONS_ENV_HEADER}\nFOO='bar'\n`,
		);
		expect(existsSync(target)).toBe(true);
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(readFileSync(target, "utf8")).toContain("FOO='bar'");

		handle.restore();
		expect(existsSync(target)).toBe(false);
	});

	it("backs up and restores a pre-existing user .env file", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-fn-env-backup-"));
		dirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const target = join(dir, ".env");
		writeFileSync(target, "USER_KEY=original\n");
		chmodSync(target, 0o640);

		const handle = writeFunctionsEnvFile(
			target,
			`${BUNCARGO_FUNCTIONS_ENV_HEADER}\nFOO='bar'\n`,
		);
		expect(readFileSync(target, "utf8")).toContain("FOO='bar'");
		expect(statSync(target).mode & 0o777).toBe(0o600);

		handle.restore();
		expect(readFileSync(target, "utf8")).toBe("USER_KEY=original\n");
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});

	it("recovers a pre-existing user .env from disk backup after an unclean crash", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-fn-env-crash-"));
		const backupDir = join(dir, ".buncargo", "backup");
		dirs.push(dir);
		const target = join(dir, ".env");
		writeFileSync(target, "USER_KEY=survives-crash\n");
		chmodSync(target, 0o640);

		// First run writes generated .env and persists backup on disk, then crashes (no restore()).
		writeFunctionsEnvFile(
			target,
			`${BUNCARGO_FUNCTIONS_ENV_HEADER}\nRUN='first'\n`,
			{ backupDir },
		);
		expect(readFileSync(target, "utf8")).toContain("RUN='first'");

		// Second run sees the generated header, picks up the disk backup, and restores the user file cleanly.
		const second = writeFunctionsEnvFile(
			target,
			`${BUNCARGO_FUNCTIONS_ENV_HEADER}\nRUN='second'\n`,
			{ backupDir },
		);
		expect(readFileSync(target, "utf8")).toContain("RUN='second'");

		second.restore();
		expect(readFileSync(target, "utf8")).toBe("USER_KEY=survives-crash\n");
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});
});
