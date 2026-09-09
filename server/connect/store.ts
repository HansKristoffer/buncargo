import { Database } from "bun:sqlite";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { chmodSync } from "node:fs";

export const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export const identifier = () => randomBytes(16).toString("hex");
/** All persisted payloads are authenticated/encrypted, including database and STCP credentials. */
export class Store {
	readonly db: Database;

	constructor(
		path: string,
		private key: Buffer,
	) {
		if (key.length !== 32) {
			throw new Error("CONNECT_STORAGE_KEY must contain 32 bytes in hex");
		}
		this.db = new Database(path, { create: true, strict: true });
		if (path !== ":memory:") {
			chmodSync(path, 0o600);
		}
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id))",
		);
	}

	get<T>(kind: string, id: string): T | undefined {
		const row = this.db
			.query("SELECT data FROM records WHERE kind=? AND id=?")
			.get(kind, id) as { data: string } | null;
		return row ? this.decode<T>(kind, id, row.data) : undefined;
	}

	list<T>(kind: string): T[] {
		return (
			this.db.query("SELECT id,data FROM records WHERE kind=?").all(kind) as {
				id: string;
				data: string;
			}[]
		).map((r) => this.decode<T>(kind, r.id, r.data));
	}

	set(kind: string, id: string, value: unknown) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		cipher.setAAD(Buffer.from(`${kind}:${id}`));
		const data = Buffer.concat([
			cipher.update(JSON.stringify(value)),
			cipher.final(),
		]);
		const encoded = Buffer.concat([iv, cipher.getAuthTag(), data]).toString(
			"base64",
		);
		this.db
			.query(
				"INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
			)
			.run(kind, id, encoded);
	}

	delete(kind: string, id: string) {
		this.db.query("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
	}

	atomic<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	close() {
		this.db.close();
	}

	private decode<T>(kind: string, id: string, value: string): T {
		const bytes = Buffer.from(value, "base64");
		const cipher = createDecipheriv(
			"aes-256-gcm",
			this.key,
			bytes.subarray(0, 12),
		);
		cipher.setAAD(Buffer.from(`${kind}:${id}`));
		cipher.setAuthTag(bytes.subarray(12, 28));
		return JSON.parse(
			Buffer.concat([
				cipher.update(bytes.subarray(28)),
				cipher.final(),
			]).toString(),
		);
	}
}
