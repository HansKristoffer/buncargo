import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	defineListRegistry,
	isRouteOwnerAlive,
	readJsonDocumentSync,
	StateFileUnreadableError,
	StateFileVersionError,
	writeJsonDocument,
	writeJsonDocumentSync,
} from "./registry-file";

interface Entry {
	name: string;
	port: number;
}

function isEntry(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<Entry>;
	return typeof entry.name === "string" && typeof entry.port === "number";
}

const registry = defineListRegistry<Entry>({
	version: 2,
	key: "entries",
	isEntry,
});

function tempFile(name = "state.json"): string {
	return join(mkdtempSync(join(tmpdir(), "buncargo-registry-")), name);
}

describe("readJsonDocumentSync", () => {
	it("returns undefined for a missing file", () => {
		expect(readJsonDocumentSync(tempFile(), (value) => value)).toBeUndefined();
	});

	it("returns undefined for malformed JSON instead of throwing", () => {
		const path = tempFile();
		writeFileSync(path, "{ not json");
		expect(readJsonDocumentSync(path, (value) => value)).toBeUndefined();
	});

	it("returns undefined when the validator rejects the document", () => {
		const path = tempFile();
		writeJsonDocumentSync(path, { offset: "nope" });
		const parsed = readJsonDocumentSync(path, (value) =>
			typeof (value as { offset?: unknown }).offset === "number"
				? (value as { offset: number })
				: undefined,
		);
		expect(parsed).toBeUndefined();
	});

	it("creates parent directories on write", () => {
		const path = join(
			mkdtempSync(join(tmpdir(), "buncargo-registry-")),
			"nested",
			"deep",
			"state.json",
		);
		writeJsonDocumentSync(path, { ok: true });
		expect(readJsonDocumentSync(path, (value) => value)).toEqual({ ok: true });
	});
});

describe("defineListRegistry", () => {
	it("refuses newer schemas on both reads and mutations without changing their bytes", async () => {
		const path = tempFile();
		const raw = JSON.stringify({
			version: 3,
			entries: [{ name: "future", port: 1234 }],
			newField: true,
		});
		writeFileSync(path, raw);
		await expect(registry.read(path)).rejects.toBeInstanceOf(
			StateFileVersionError,
		);
		await expect(registry.write(path, [])).rejects.toBeInstanceOf(
			StateFileVersionError,
		);
		await expect(
			registry.write(path, [{ name: "api", port: 3000 }]),
		).rejects.toBeInstanceOf(StateFileVersionError);
		expect(readFileSync(path, "utf8")).toBe(raw);
	});

	it("preserves corrupt bytes before repairing a registry", async () => {
		const path = tempFile();
		writeFileSync(path, "{broken secret state");
		await registry.write(path, [{ name: "api", port: 3000 }]);
		const backups = readdirSync(dirname(path)).filter((name) =>
			name.includes(".recovery-"),
		);
		expect(backups).toHaveLength(1);
		const backup = join(dirname(path), backups[0] ?? "missing-backup");
		expect(readFileSync(backup, "utf8")).toBe("{broken secret state");
		expect(statSync(backup).mode & 0o777).toBe(0o600);
		expect(await registry.read(path)).toEqual([{ name: "api", port: 3000 }]);
	});

	it("preserves discarded invalid records before an empty-list deletion", async () => {
		const path = tempFile();
		const raw = JSON.stringify({
			version: 2,
			entries: [{ unexpected: "record" }],
		});
		writeFileSync(path, raw);
		await registry.write(path, []);
		const backup = readdirSync(dirname(path)).find((name) =>
			name.includes(".recovery-"),
		);
		expect(backup).toBeDefined();
		expect(
			readFileSync(join(dirname(path), backup ?? "missing-backup"), "utf8"),
		).toBe(raw);
		expect(existsSync(path)).toBe(false);
	});

	it("does not replace unchanged state on repeated writes", async () => {
		const path = tempFile();
		const entries = [{ name: "api", port: 3000 }];
		await registry.write(path, entries);
		const before = statSync(path);
		await registry.write(path, entries);
		expect(statSync(path).ino).toBe(before.ino);
		expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
	});

	it("round-trips entries", async () => {
		const path = tempFile();
		await registry.write(path, [{ name: "api", port: 3000 }]);
		expect(await registry.read(path)).toEqual([{ name: "api", port: 3000 }]);
	});

	it("deletes the file once the last entry is gone", async () => {
		const path = tempFile();
		await registry.write(path, [{ name: "api", port: 3000 }]);
		await registry.write(path, []);
		expect(existsSync(path)).toBe(false);
		expect(await registry.read(path)).toEqual([]);
	});

	it("reads empty on a version mismatch", async () => {
		const path = tempFile();
		writeJsonDocumentSync(path, {
			version: 1,
			entries: [{ name: "api", port: 3000 }],
		});
		expect(await registry.read(path)).toEqual([]);
	});

	it("drops invalid entries but keeps the valid ones", async () => {
		const path = tempFile();
		writeJsonDocumentSync(path, {
			version: 2,
			entries: [{ name: "api", port: 3000 }, { name: "web" }, null, 7],
		});
		expect(await registry.read(path)).toEqual([{ name: "api", port: 3000 }]);
	});

	it("reads empty on corruption", async () => {
		const path = tempFile();
		writeFileSync(path, "]]not json[[");
		expect(await registry.read(path)).toEqual([]);
	});

	describe("strict", () => {
		it("still reads a missing file as empty", async () => {
			expect(await registry.read(tempFile(), { strict: true })).toEqual([]);
		});

		it("refuses to call a corrupt file empty", async () => {
			const path = tempFile();
			writeFileSync(path, "]]not json[[");
			await expect(registry.read(path, { strict: true })).rejects.toThrow(
				"could not be read",
			);
		});

		it("refuses to call a wrong-version file empty", async () => {
			const path = tempFile();
			writeJsonDocumentSync(path, {
				version: 1,
				entries: [{ name: "api", port: 3000 }],
			});
			await expect(registry.read(path, { strict: true })).rejects.toThrow(
				StateFileUnreadableError,
			);
		});

		it("surfaces an unreadable directory rather than an empty list", async () => {
			const dir = mkdtempSync(join(tmpdir(), "buncargo-registry-"));
			// A directory in place of the file: readFile fails with EISDIR, the
			// stand-in here for the EACCES a root-written state file produces.
			await expect(registry.read(dir, { strict: true })).rejects.toThrow(
				StateFileUnreadableError,
			);
		});
	});
});

describe("isRouteOwnerAlive", () => {
	it("treats an ownerless entry as alive", () => {
		expect(isRouteOwnerAlive(undefined)).toBe(true);
	});

	it("follows the owning process", () => {
		expect(isRouteOwnerAlive(process.pid)).toBe(true);
		expect(isRouteOwnerAlive(99_999_999)).toBe(false);
	});
});

describe("private atomic publication", () => {
	it("creates both async and sync state files privately before publication", async () => {
		const asyncPath = tempFile();
		const syncPath = tempFile();
		await writeJsonDocument(asyncPath, { password: "private" });
		writeJsonDocumentSync(syncPath, { password: "private" });
		expect(statSync(asyncPath).mode & 0o777).toBe(0o600);
		expect(statSync(syncPath).mode & 0o777).toBe(0o600);
	});
});
