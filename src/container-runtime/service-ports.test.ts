import { describe, expect, it } from "bun:test";
import { assertServicePortsClaimable } from "./service-ports";
import type { ContainerRuntimeAdapter } from "./types";

/** A runtime with no containers, so a listener reads as a plain process. */
const runtime = {
	name: "orbstack",
	containerPortOwnersAsync: async () => new Map(),
	containerPortOwners: () => new Map(),
	findContainerOnPort: () => undefined,
} as unknown as ContainerRuntimeAdapter;

// The checkout lies outside this process's cwd, so its listener is foreign.
const context = { root: "/nonexistent/checkout", projectName: "p" };

function listen() {
	return Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
}

describe("assertServicePortsClaimable", () => {
	it("waits for a port its holder is about to release", async () => {
		// OrbStack keeps listening for about half a second after `docker stop`.
		const holder = listen();
		setTimeout(() => holder.stop(true), 400);

		await assertServicePortsClaimable(
			runtime,
			{ db: { port: holder.port } },
			{ db: holder.port },
			context,
		);
	});

	it("still names a process that keeps the port", async () => {
		const holder = listen();
		try {
			await expect(
				assertServicePortsClaimable(
					runtime,
					{ db: { port: holder.port } },
					{ db: holder.port },
					context,
				),
			).rejects.toThrow(`port ${holder.port} held by process ${process.pid}`);
		} finally {
			holder.stop(true);
		}
	});
});
