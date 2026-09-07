import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateFilePath } from "../state-paths";

export const bundleHash = (contents: string) =>
	createHash("sha256").update(contents).digest("hex");

/** Locate our package from either source or dist, independent of the caller's worktree. */
export async function tailnetBundle() {
	let root = dirname(fileURLToPath(import.meta.url));

	while (true) {
		try {
			const manifest = JSON.parse(
				await readFile(join(root, "package.json"), "utf8"),
			);

			if (manifest.name === "buncargo") {
				const contents = await readFile(join(root, "dist/tailnetd.js"), "utf8");

				return {
					contents,
					version: String(manifest.version),
					hash: bundleHash(contents),
				};
			}
		} catch {
			/* Continue to the package ancestor. */
		}

		if (dirname(root) === root)
			throw new Error(
				"Missing tailnet daemon bundle. Run bun run build or reinstall buncargo.",
			);

		root = dirname(root);
	}
}

export interface InstalledTailnetAgent {
	version: string;
	hash: string;
	script: string;
	bun: string;
	binary: string;
}

/** Older installations may have no manifest; diagnostics treat that as unknown provenance. */
export async function installedTailnetAgent(): Promise<
	InstalledTailnetAgent | undefined
> {
	try {
		const v = JSON.parse(
			await readFile(stateFilePath("tailnet-service.json"), "utf8"),
		);

		if (
			[v.version, v.hash, v.script, v.bun, v.binary].every(
				(x) => typeof x === "string",
			)
		)
			return v;
	} catch {
		/* Missing/older installation. */
	}

	return undefined;
}
