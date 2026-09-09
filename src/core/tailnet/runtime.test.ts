import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTailnetRuntime } from "./runtime";
import { fakeTailscale } from "./test-helpers.test";

test("an existing login is reused without installation, enrollment or logout", async () => {
	let installed = false;
	const fake = fakeTailscale();
	const runtime = await startTailnetRuntime(
		"unused-secret",
		new AbortController().signal,
		{
			binary: () => "existing",
			install: async () => {
				installed = true;
				throw new Error("unexpected");
			},
			command: () => fake.command,
		},
	);
	await runtime.close();
	expect(installed).toBe(false);
	expect(fake.calls).toEqual([["status", "--json"]]);
});
test("no installation or sign-in is attempted without an auth key", async () => {
	let installed = false;
	await expect(
		startTailnetRuntime(undefined, new AbortController().signal, {
			binary: () => undefined,
			install: async () => {
				installed = true;
				throw new Error();
			},
		}),
	).rejects.toThrow("TS_AUTHKEY");
	expect(installed).toBe(false);
});
test("concurrent enrollment uses separate sockets and hosts, private key files and memory-only state", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-runtime-"));
	const daemon = join(dir, "tailscaled");
	await writeFile(daemon, `#!${process.execPath}\nsetInterval(()=>{},1000);`, {
		mode: 0o755,
	});
	const hosts: string[] = [],
		sockets: string[] = [],
		keys: string[] = [];
	const runtimes: Awaited<ReturnType<typeof startTailnetRuntime>>[] = [];
	try {
		const create = () =>
			startTailnetRuntime("same-reusable-key", new AbortController().signal, {
				binary: () => undefined,
				install: async () => ({ binary: "fake", daemon }),
				command: (_binary, socket) => {
					sockets.push(socket as string);
					return async (args) => {
						if (args[0] === "up") {
							const path = args
								.find((a) => a.startsWith("--auth-key=file:"))
								?.slice("--auth-key=file:".length) as string;
							expect(await readFile(path, "utf8")).toBe("same-reusable-key");
							expect((await stat(path)).mode & 0o777).toBe(0o600);
							expect(args.join(" ")).not.toContain("same-reusable-key");
							keys.push(path);
							hosts.push(
								args.find((a) => a.startsWith("--hostname=")) as string,
							);
							return "";
						}
						return fakeTailscale().command(args);
					};
				},
			});
		runtimes.push(...(await Promise.all([create(), create()])));
		expect(new Set(hosts).size).toBe(2);
		expect(new Set(sockets).size).toBe(2);
		for (const key of keys) expect(existsSync(key)).toBe(false);
	} finally {
		await Promise.all(runtimes.map((r) => r.close()));
		await rm(dir, { recursive: true, force: true });
	}
});
