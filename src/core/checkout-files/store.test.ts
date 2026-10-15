import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	isLockStale,
	LOCK_STALE_MS,
	readManifest,
	readStoreData,
	sha256,
	withStoreLock,
	writeStoreEntries,
} from "./store";

const fixtures = join(import.meta.dir, "fixtures", "stores");
/** A fixture is a store root, laid out like `~/.buncargo/files`. */
const fixture = (name: string) =>
	join(fixtures, name, "github.com", "acme", "app");

const temps: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-store-"));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A pid that existed and has exited. */
function deadPid(): number {
	return spawnSync("true").pid;
}

describe("reading the fixture stores", () => {
	it("reads every entry of a healthy store", () => {
		const dir = fixture("basic");
		const read = readManifest(dir);
		if (read.kind !== "ok") throw new Error(read.kind);
		expect(Object.keys(read.manifest.files).sort()).toEqual([
			".env.local",
			".env.machine",
			"apps/mobile/.env",
		]);
		expect(read.manifest.files[".env.machine"]?.machine).toBe(true);
		for (const [path, entry] of Object.entries(read.manifest.files))
			expect(readStoreData(dir, path, entry)).toBeDefined();
	});

	it("treats a data file that does not match its entry as absent", () => {
		const dir = fixture("mid-write");
		const read = readManifest(dir);
		if (read.kind !== "ok") throw new Error(read.kind);
		const entry = read.manifest.files[".env.local"];
		if (!entry) throw new Error("no entry");
		expect(readStoreData(dir, ".env.local", entry)).toBeUndefined();
	});

	it("leaves a store with an unknown version alone", () => {
		expect(readManifest(fixture("unknown-version"))).toEqual({
			kind: "unusable",
			reason: "manifest.json has version 2, this buncargo reads 1",
		});
	});

	it("ignores data files without an entry", () => {
		const read = readManifest(fixture("orphan-data"));
		if (read.kind !== "ok") throw new Error(read.kind);
		expect(Object.keys(read.manifest.files)).toEqual([".env.local"]);
	});

	it("reads a missing store as absent", () => {
		expect(readManifest(join(temp(), "nope"))).toEqual({ kind: "absent" });
	});
});

describe("writeStoreEntries", () => {
	it("writes owner-only data and manifest", () => {
		const dir = join(temp(), "store");
		const data = Buffer.from("A=1\n");
		const manifest = writeStoreEntries(
			dir,
			{ version: 1, files: {} },
			[{ path: "apps/web/.env", data, machine: false }],
			new Date("2026-10-15T00:00:00Z"),
		);
		expect(manifest.files["apps/web/.env"]).toEqual({
			sha256: sha256(data),
			updatedAt: "2026-10-15T00:00:00.000Z",
			machine: false,
		});
		expect(readFileSync(join(dir, "data", "apps", "web", ".env"), "utf8")).toBe(
			"A=1\n",
		);
		expect(statSync(join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "data", "apps")).mode & 0o777).toBe(0o700);
		expect(readManifest(dir)).toEqual({ kind: "ok", manifest });
	});

	it("keeps updatedAt when the bytes did not change", () => {
		const dir = join(temp(), "store");
		const data = Buffer.from("A=1\n");
		const first = writeStoreEntries(
			dir,
			{ version: 1, files: {} },
			[{ path: ".env", data, machine: false }],
			new Date("2026-10-15T00:00:00Z"),
		);
		const second = writeStoreEntries(
			dir,
			first,
			[{ path: ".env", data, machine: true }],
			new Date("2026-10-16T00:00:00Z"),
		);
		expect(second.files[".env"]).toEqual({
			sha256: sha256(data),
			updatedAt: "2026-10-15T00:00:00.000Z",
			machine: true,
		});
	});
});

describe("isLockStale", () => {
	const now = Date.parse("2026-10-15T12:00:00Z");
	const fresh = new Date(now - 1000).toISOString();
	const alive = () => true;
	const dead = () => false;

	it("breaks a lock whose owner died on this host", () => {
		expect(
			isLockStale(
				{ pid: 1, host: "here", createdAt: fresh },
				now,
				now,
				"here",
				dead,
			),
		).toBe(true);
	});

	it("keeps a fresh lock from another host, whose pid it cannot check", () => {
		expect(
			isLockStale(
				{ pid: 1, host: "there", createdAt: fresh },
				now,
				now,
				"here",
				dead,
			),
		).toBe(false);
	});

	it("keeps a fresh lock with a live owner", () => {
		expect(
			isLockStale(
				{ pid: 1, host: "here", createdAt: fresh },
				now,
				now,
				"here",
				alive,
			),
		).toBe(false);
	});

	it("breaks any lock older than 30 s", () => {
		const old = new Date(now - LOCK_STALE_MS - 1).toISOString();
		expect(
			isLockStale(
				{ pid: 1, host: "there", createdAt: old },
				now,
				now,
				"here",
				alive,
			),
		).toBe(true);
	});

	it("waits for a lock whose owner is still being written, until it is 30 s old", () => {
		expect(isLockStale(undefined, now - 1000, now, "here", alive)).toBe(false);
		expect(
			isLockStale(undefined, now - LOCK_STALE_MS - 1, now, "here", alive),
		).toBe(true);
	});
});

describe("withStoreLock", () => {
	function holdLock(dir: string, owner: object): void {
		mkdirSync(join(dir, ".lock"), { recursive: true });
		writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify(owner));
	}

	it("takes and releases the lock", async () => {
		const dir = join(temp(), "store");
		const owner = await withStoreLock(dir, () =>
			JSON.parse(readFileSync(join(dir, ".lock", "owner.json"), "utf8")),
		);
		expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
		expect(() => statSync(join(dir, ".lock"))).toThrow();
	});

	it("breaks a stale lock left by a dead process", async () => {
		const dir = join(temp(), "store");
		holdLock(dir, {
			pid: deadPid(),
			host: hostname(),
			createdAt: new Date().toISOString(),
		});
		expect(await withStoreLock(dir, () => "ran", 1000)).toBe("ran");
	});

	it("breaks a lock older than 30 s even when its owner looks alive", async () => {
		const dir = join(temp(), "store");
		holdLock(dir, {
			pid: process.pid,
			host: hostname(),
			createdAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString(),
		});
		expect(await withStoreLock(dir, () => "ran", 1000)).toBe("ran");
	});

	it("waits for a live lock and names it when time runs out", async () => {
		const dir = join(temp(), "store");
		holdLock(dir, {
			pid: process.pid,
			host: hostname(),
			createdAt: new Date().toISOString(),
		});
		await expect(withStoreLock(dir, () => "ran", 100)).rejects.toThrow(
			`locked by pid ${process.pid}`,
		);
	});

	it("does not break a lock whose owner file is not written yet", async () => {
		const dir = join(temp(), "store");
		mkdirSync(join(dir, ".lock"), { recursive: true });
		await expect(withStoreLock(dir, () => "ran", 100)).rejects.toThrow(
			"locked",
		);
		const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
		utimesSync(join(dir, ".lock"), old, old);
		expect(await withStoreLock(dir, () => "ran", 1000)).toBe("ran");
	});

	it("serializes holders", async () => {
		const dir = join(temp(), "store");
		const events: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withStoreLock(dir, async () => {
			events.push("first in");
			await gate;
			events.push("first out");
		});
		const second = withStoreLock(dir, () => {
			events.push("second in");
		});
		// The first body is already waiting on the gate: it ran synchronously.
		events.push("released");
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["first in", "released", "first out", "second in"]);
	});
});
