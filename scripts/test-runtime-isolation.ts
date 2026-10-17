/** Unit tests must not depend on or mutate the developer's container daemons. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The explicitly enabled Apple integration exercises the real installed runtime.
// Docker integration runs as a separate script, outside this test preload.
if (
	!process.env.BUNCARGO_TEST_APPLE_CONTAINER &&
	process.platform !== "win32"
) {
	const directory = mkdtempSync(join(tmpdir(), "buncargo-test-runtimes-"));
	for (const name of ["docker", "container"]) {
		const path = join(directory, name);
		writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		chmodSync(path, 0o700);
	}
	process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ""}`;
	process.once("exit", () =>
		rmSync(directory, { recursive: true, force: true }),
	);

	// The stubs go when this process exits, but a watchdog a test's run
	// started may outlive it, with an isolated HOME whose registry names no
	// stack, and then find the real `docker` further down PATH. A dead
	// DOCKER_HOST outlives the stubs; with the tailnet directory off, such a
	// watchdog has nothing to serve and exits.
	process.env.DOCKER_HOST = "unix:///nonexistent/buncargo-test.sock";
	delete process.env.DOCKER_CONTEXT;
	process.env.BUNCARGO_TAILNET_DIRECTORY = "0";
}
