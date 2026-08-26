/**
 * Entrypoint for the named-hosts daemon when it runs as a system service.
 *
 * This is bundled to a single self-contained `dist/hostsd.js` and copied to a
 * root-owned directory at install time. The full CLI cannot be used for that:
 * `dist/cli/bin.js` is code-split across sibling chunks inside a project's
 * `node_modules`, and macOS denies a root daemon any path under `~/Documents`,
 * so launchd cannot even read it.
 *
 * Keep the import graph here as narrow as the daemon needs.
 */

import { writeSync } from "node:fs";
import { runHostsDaemon } from "../core/hosts/daemon";

runHostsDaemon({ service: true }).catch((error: unknown) => {
	const message =
		error instanceof Error ? error.stack || error.message : String(error);
	// Straight to fd 2: Bun buffers stderr when it is a file, and the service
	// log is exactly that, so a buffered write would be lost on exit.
	try {
		writeSync(2, `[buncargo hosts] daemon exited: ${message}\n`);
	} catch {
		console.error(message);
	}
	process.exit(1);
});
