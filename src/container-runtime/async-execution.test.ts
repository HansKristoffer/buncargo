import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleContainerRuntimeAdapter } from "../apple-container/adapter";
import { dockerRuntimeAdapter } from "../docker/adapter";

/** Real disposable CLIs exercise cancellation across the adapter/executor seam. */
for (const name of ["docker", "apple"] as const) {
	describe(`${name} asynchronous runtime operations`, () => {
		async function fixture() {
			const root = await mkdtemp(join(tmpdir(), "buncargo-runtime-"));
			const binary = join(root, "runtime with spaces.ts");
			const pidFile = join(root, "pid");
			const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
			await Bun.write(
				binary,
				`#!/bin/sh
printf '%s' "$$" > ${quote(pidFile)}
if [ "$1" = "ls" ]; then printf '[]'; exit 0; fi
exec ${quote(process.execPath)} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
`,
			);
			await chmod(binary, 0o755);
			const runtime =
				name === "docker"
					? dockerRuntimeAdapter({ binary })
					: appleContainerRuntimeAdapter({ binary });
			return { root, runtime, pidFile };
		}

		it("bounds an in-container probe and kills the CLI process", async () => {
			const { root, runtime, pidFile } = await fixture();
			try {
				const start = performance.now();
				const ready = await runtime.execInServiceAsync?.({
					projectName: "demo",
					serviceName: "db",
					command: ["probe", "literal argument"],
					timeoutMs: 500,
				});
				expect(ready).toBe(false);
				expect(performance.now() - start).toBeLessThan(1500);
				const pid = Number(await Bun.file(pidFile).text());
				expect(() => process.kill(pid, 0)).toThrow();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("cancels startup while keeping the event loop responsive", async () => {
			const { root, runtime, pidFile } = await fixture();
			const controller = new AbortController();
			try {
				const start = performance.now();
				const timer = setTimeout(
					() => controller.abort(new Error("cancel startup")),
					500,
				);
				try {
					await expect(
						runtime.upAsync?.({
							root,
							projectName: "demo",
							envVars: {},
							serviceNames: ["db"],
							model: { services: { db: { image: "postgres:16" } } },
							verbose: false,
							signal: controller.signal,
						}),
					).rejects.toThrow("cancel startup");
				} finally {
					clearTimeout(timer);
				}
				expect(performance.now() - start).toBeLessThan(1500);
				const pid = Number(await Bun.file(pidFile).text());
				expect(() => process.kill(pid, 0)).toThrow();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});
}
