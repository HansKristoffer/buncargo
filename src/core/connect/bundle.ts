import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hashDaemonBundle, packageRoot } from "../hosts/daemon-bundle";
import { stateFilePath } from "../state-paths";

/** One immutable bundle serves both the publisher and receiver. It survives bunx cache eviction. */
export function installConnectBundle(): string {
	// The bar executes this immutable bundle directly, outside any installed package.
	const entry = process.argv[1];
	if (
		entry &&
		/^connectd(?:-[a-f0-9]+)?\.js$/.test(basename(entry)) &&
		existsSync(entry)
	)
		return realpathSync(entry);

	const source = join(packageRoot().dir, "dist", "connectd.js");
	if (!existsSync(source))
		throw new Error(
			"The Connection bundle is missing. Build Buncargo with bun run build or reinstall the CLI.",
		);
	const contents = readFileSync(source, "utf8");
	const path = stateFilePath(`bin/connectd-${hashDaemonBundle(contents)}.js`);
	if (!existsSync(path)) {
		mkdirSync(stateFilePath("bin"), { recursive: true });
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	// Bun resolves script symlinks before setting argv[1]; coordinator comparisons must use that same path.
	return realpathSync(path);
}
