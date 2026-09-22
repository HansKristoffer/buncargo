import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { hashDaemonBundle, packageRoot } from "../hosts/daemon-bundle";
import { stateFilePath } from "../state-paths";
import { addonPathFor } from "./iroh";

/**
 * The native addon built for this computer.
 *
 * Only the matching optional dependency is normally installed; on a machine
 * carrying several, glibc decides between the Linux builds. Picking the wrong
 * one is a load-time crash, not a slow path.
 */
function addonSource(): string {
	const scope = dirname(
		dirname(
			createRequire(import.meta.url).resolve("@number0/iroh/package.json"),
		),
	);
	const prefix = `iroh-${process.platform}-${process.arch}`;
	const glibc = !!(
		process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
	)?.header?.glibcVersionRuntime;
	const candidates = readdirSync(scope)
		.filter((name) => name.startsWith(prefix))
		.sort((name) => (name.endsWith("musl") === glibc ? 1 : -1));
	for (const name of candidates) {
		const directory = join(scope, name);
		const file = readdirSync(directory).find((entry) =>
			entry.endsWith(".node"),
		);
		if (file) {
			return join(directory, file);
		}
	}
	throw new Error(
		`No iroh addon for ${process.platform}-${process.arch}. Reinstall the CLI.`,
	);
}

function install(path: string, write: (temporary: string) => void): void {
	if (existsSync(path)) {
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		write(temporary);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * One immutable bundle serves both the publisher and the receiver.
 *
 * It survives bunx cache eviction, and the addon travels with it under the
 * same hash: a `.node` file cannot be bundled, and the bar runs this bundle
 * from outside any `node_modules`.
 */
export function installConnectBundle(): string {
	// The bar executes this immutable bundle directly, outside any installed package.
	const entry = process.argv[1];
	if (
		entry &&
		/^connectd(?:-[a-f0-9]+)?\.js$/.test(basename(entry)) &&
		existsSync(entry)
	) {
		return realpathSync(entry);
	}

	const source = join(packageRoot().dir, "dist", "connectd.js");
	if (!existsSync(source)) {
		throw new Error(
			"The Connection bundle is missing. Build Buncargo with bun run build or reinstall the CLI.",
		);
	}
	const contents = readFileSync(source, "utf8");
	const path = stateFilePath(`bin/connectd-${hashDaemonBundle(contents)}.js`);
	install(path, (temporary) =>
		writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" }),
	);
	install(addonPathFor(path), (temporary) =>
		copyFileSync(addonSource(), temporary),
	);
	// Bun resolves script symlinks before setting argv[1]; coordinator comparisons must use that same path.
	return realpathSync(path);
}
