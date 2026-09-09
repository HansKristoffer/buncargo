import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailscaleTestsEnabled } from "../runtime-flags";
import { installTailscale, TAILSCALE_VERSION } from "./binary";
import { startGuardedChild } from "./child-guard";
import { createTailscaleClient } from "./client";

test.skipIf(!tailscaleTestsEnabled() || process.platform !== "linux")(
	"official verified binaries start without TUN, root networking or a login",
	async () => {
		const { binary, daemon } = await installTailscale();
		const directory = await mkdtemp(join(tmpdir(), "bc-real-ts-")),
			socket = join(directory, "tailscaled.sock");
		const child = startGuardedChild(
			daemon,
			["--tun=userspace-networking", "--state=mem:", `--socket=${socket}`],
			directory,
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
			await child.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	180000,
);
