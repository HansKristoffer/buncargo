/** Unit tests must not depend on or mutate the developer's container daemons or state. */
import { afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readProcessIdentity } from "../src/core/process-identity";
import { stopWatchdog } from "../src/core/watchdog.testing";

/**
 * The opt-in suites that run against the real machine on purpose
 * (docs/testing.md). They read the real home (a cached mkcert, a CLI's login)
 * and move `HOME` themselves where they write state.
 */
const REAL_MACHINE_SUITES = [
	"BUNCARGO_TEST_APPLE_CONTAINER",
	"BUNCARGO_TEST_CLOUDFLARED_SMOKE",
	"BUNCARGO_TEST_FRP",
	"BUNCARGO_TEST_HOSTS",
	"BUNCARGO_TEST_HOSTS_SOAK",
	"BUNCARGO_TEST_PROXY_IDLE",
	"BUNCARGO_TEST_SHOPIFY_CLI",
] as const;

// Every watchdog a test starts, under any HOME, exits once this run has
// ended: a temporary HOME alone does not keep a sweep off the machine's
// container daemon.
process.env.BUNCARGO_WATCHDOG_PARENT = `${process.pid}:${readProcessIdentity(process.pid) ?? ""}`;

// The whole run gets a temporary home, so a test that forgets to move HOME
// writes there rather than to the developer's `~/.buncargo`. A test that sets
// its own HOME still can.
if (!REAL_MACHINE_SUITES.some((name) => process.env[name])) {
	const realHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "buncargo-test-home-"));
	process.env.HOME = home;
	afterAll(async () => {
		await stopWatchdog();
		// Bun writes its transpiler cache under HOME as it exits, after this.
		process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
	});
}

// The explicitly enabled Apple integration exercises the real installed runtime.
// Docker integration runs as a separate script, outside this test preload.
if (
	!process.env.BUNCARGO_TEST_APPLE_CONTAINER &&
	process.platform !== "win32"
) {
	const directory = mkdtempSync(join(tmpdir(), "buncargo-test-runtimes-"));
	// `tailscale` too: a serve entry is machine state that outlives the test
	// run, and the tests inject their own CLI.
	for (const name of ["docker", "container", "tailscale"]) {
		const path = join(directory, name);
		writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		chmodSync(path, 0o700);
	}
	process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ""}`;
	// A global `afterAll`: Bun runs no `exit` handler of a test preload.
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	// The stubs go when the run ends, but a watchdog a test's run
	// started may outlive it, with an isolated HOME whose registry names no
	// stack, and then find the real `docker` further down PATH. A dead
	// DOCKER_HOST outlives the stubs; with the tailnet directory off, such a
	// watchdog has nothing to serve and exits.
	process.env.DOCKER_HOST = "unix:///nonexistent/buncargo-test.sock";
	delete process.env.DOCKER_CONTEXT;
	process.env.BUNCARGO_TAILNET_DIRECTORY = "0";
}
