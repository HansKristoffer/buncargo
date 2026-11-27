import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "hanzio";
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

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function collectPrismaFiles(
	root: string,
	prefix = "",
	out: string[] = [],
): string[] {
	const dir = prefix ? join(root, prefix) : root;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectPrismaFiles(
				root,
				prefix ? `${prefix}/${entry.name}` : entry.name,
				out,
			);
		} else if (entry.isFile() && entry.name.endsWith(".prisma")) {
			out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
		}
	}
	return out;
}

/** Hash of every `.prisma` file under the Prisma directory, in path order. */
export function prismaSchemaHash(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const files = collectPrismaFiles(dir).sort();
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
		isRecord(value) && typeof value.schemaHash === "string"
			? { schemaHash: value.schemaHash }
			: undefined,
	)?.schemaHash;
}

/** Best-effort: a checkout that cannot write its state dir just re-checks. */
function recordGeneratedPrismaHash(root: string, prismaDir: string): void {
	const schemaHash = prismaSchemaHash(prismaDir);
	if (!schemaHash) return;
	try {
		writeJsonDocumentSync(projectStateFilePath(root, FILENAME), { schemaHash });
	} catch {
		// Not worth failing a start over.
	}
}

/**
 * Run `prisma.generate` through `run` and, when it succeeds, record the
 * schema it generated from. `cwd` is the Prisma directory, relative to `root`.
 */
export async function generatePrismaClient(
	root: string,
	cwd: string,
	run: () => Promise<{ exitCode: number }>,
): Promise<number> {
	const { exitCode } = await run();
	if (exitCode === 0) recordGeneratedPrismaHash(root, join(root, cwd));
	return exitCode;
}

/**
 * Whether `prisma.generate` has to run: the `.prisma` files under `cwd`
 * differ from the ones buncargo last generated from. A schema it cannot
 * find runs generate.
 */
export function prismaClientStale(root: string, cwd: string): boolean {
	const current = prismaSchemaHash(join(root, cwd));
	return current === undefined || current !== readGeneratedPrismaHash(root);
}
