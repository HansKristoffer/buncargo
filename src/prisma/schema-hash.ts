import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	readJsonDocumentSync,
	writeJsonDocumentSync,
} from "../core/registry-file";
import { projectStateFilePath } from "../core/state-paths";

/**
 * Whether the Prisma client was generated from the schema on disk.
 *
 * buncargo records the schema's hash each time it runs `prisma.generate`, so
 * `buncargo setup` can tell a stale client from a current one without
 * knowing where Prisma put it (Prisma 7 generates to a custom `output`).
 */

const FILENAME = "prisma-generate.json";

/** Hash of every `.prisma` file under the Prisma directory, in path order. */
export function prismaSchemaHash(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const files = [
		...new Bun.Glob("**/*.prisma").scanSync({ cwd: dir, onlyFiles: true }),
	]
		.filter((path) => !path.includes("node_modules"))
		.sort();
	if (files.length === 0) return undefined;

	const hash = createHash("sha256");
	for (const file of files) {
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(join(dir, file)));
	}
	return hash.digest("hex");
}

export function readGeneratedPrismaHash(root: string): string | undefined {
	return readJsonDocumentSync(projectStateFilePath(root, FILENAME), (value) =>
		typeof value === "object" &&
		value !== null &&
		typeof (value as { schemaHash?: unknown }).schemaHash === "string"
			? (value as { schemaHash: string })
			: undefined,
	)?.schemaHash;
}

/** Best-effort: a checkout that cannot write its state dir just re-checks. */
export function recordGeneratedPrismaHash(
	root: string,
	prismaDir: string,
): void {
	const schemaHash = prismaSchemaHash(prismaDir);
	if (!schemaHash) return;
	try {
		writeJsonDocumentSync(projectStateFilePath(root, FILENAME), { schemaHash });
	} catch {
		// Not worth failing a start over.
	}
}
