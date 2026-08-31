import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defineListRegistry,
	isRouteOwnerAlive,
	readJsonDocumentSync,
	StateFileUnreadableError,
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
