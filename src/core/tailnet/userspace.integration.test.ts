import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailscaleProcessEnv, tailscaleTestsEnabled } from "../runtime-flags";
import { installTailscale, TAILSCALE_VERSION } from "./binary";
import { CHILD_GUARD } from "./child-guard";
import { createTailscaleClient } from "./client";

test.skipIf(!tailscaleTestsEnabled() || process.platform !== "linux")(
	"official verified binaries start without TUN, root networking or a login",
	async () => {
		const { binary, daemon } = await installTailscale();
		const directory = await mkdtemp(join(tmpdir(), "bc-real-ts-")),
			socket = join(directory, "tailscaled.sock");
		const child = spawn(
			process.execPath,
			[
				"-e",
				CHILD_GUARD,
				"--",
				directory,
				daemon,
				"--tun=userspace-networking",
				"--state=mem:",
				`--socket=${socket}`,
			],
			{
				env: tailscaleProcessEnv(),
				stdio: ["pipe", "ignore", "ignore"],
			},
		);
		const finished = new Promise<void>((resolve) =>
			child.once("exit", () => resolve()),
		);
		const command = createTailscaleClient(binary, socket);
		try {
			expect(await command(["version"])).toContain(TAILSCALE_VERSION);
			let status: { BackendState?: string } | undefined;
			for (let i = 0; i < 100; i++) {
				try {
					status = JSON.parse(await command(["status", "--json"]));
					break;
				} catch {
					await Bun.sleep(100);
				}
			}
			expect(status?.BackendState).toBe("NeedsLogin");
		} finally {
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			try {
				await finished;
			} finally {
				clearTimeout(timer);
				await rm(directory, { recursive: true, force: true });
			}
		}
	},
	180000,
);
