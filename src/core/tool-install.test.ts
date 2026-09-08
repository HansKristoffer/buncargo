import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInstalledTool } from "./tool-binary";
import { downloadToolAsset, installTool, type ToolFetch } from "./tool-install";

const directories: string[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "buncargo installer ' $; "));
	directories.push(path);
	return path;
}
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});
const executable = "#!/bin/sh\necho 'fixture version 1.2.3'\n";
const installOptions = (to: string, fetcher: ToolFetch) => ({
	to,
	url: "https://downloads.example/tool",
	versionArgs: ["--version"],
	expectedVersion: /fixture version 1\.2\.3/,
	fetch: fetcher,
});

describe("downloadToolAsset", () => {
	for (const status of [404, 429, 500]) {
		it(`does not publish HTTP ${status} as an executable`, async () => {
			const to = join(directory(), "download");
			await expect(
				downloadToolAsset("https://example.com/tool", to, {
					fetch: async () => new Response("error", { status }),
				}),
			).rejects.toThrow(`HTTP ${status}`);
			expect(existsSync(to)).toBe(false);
		});
	}
	it("follows relative redirects and bounds redirect loops", async () => {
		const to = join(directory(), "download");
		const requests: string[] = [];
		await downloadToolAsset("https://example.com/start", to, {
			fetch: async (url) => {
				requests.push(url);
				return requests.length === 1
					? new Response(null, { status: 307, headers: { location: "/tool" } })
					: new Response("complete");
			},
		});
		expect(requests).toEqual([
			"https://example.com/start",
			"https://example.com/tool",
		]);
		expect(readFileSync(to, "utf8")).toBe("complete");
		await expect(
			downloadToolAsset("https://example.com/loop", `${to}.loop`, {
				maxRedirects: 2,
				fetch: async () =>
					new Response(null, { status: 308, headers: { location: "/loop" } }),
			}),
		).rejects.toThrow("redirect limit");
	});
	it("rejects HTTPS redirects to plaintext HTTP", async () => {
		await expect(
			downloadToolAsset(
				"https://example.com/tool",
				join(directory(), "download"),
				{
					fetch: async () =>
						new Response(null, {
							status: 302,
							headers: { location: "http://example.com/tool" },
						}),
				},
			),
		).rejects.toThrow("requires HTTPS");
	});
	it("removes truncated downloads", async () => {
		const to = join(directory(), "download");
		await expect(
			downloadToolAsset("https://example.com/tool", to, {
				fetch: async () =>
					new Response("partial", { headers: { "content-length": "100" } }),
			}),
		).rejects.toThrow("truncated");
		expect(existsSync(to)).toBe(false);
	});
	it("bounds a response body that never ends", async () => {
		const to = join(directory(), "download");
		let cancelled = false;
		const started = performance.now();
		await expect(
			downloadToolAsset("https://example.com/tool", to, {
				timeoutMs: 40,
				fetch: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array([1]));
							},
							cancel() {
								cancelled = true;
							},
						}),
					),
			}),
		).rejects.toThrow("timed out");
		expect(performance.now() - started).toBeLessThan(500);
		expect(existsSync(to)).toBe(false);
		expect(cancelled).toBe(true);
	});
	it("aborts an interrupted download and removes its staging file", async () => {
		const controller = new AbortController();
		const to = join(directory(), "download");
		const downloading = downloadToolAsset("https://example.com/tool", to, {
			signal: controller.signal,
			fetch: async () => new Response(new ReadableStream()),
		});
		setTimeout(() => controller.abort(new Error("cancelled")), 20);
		await expect(downloading).rejects.toThrow("cancelled");
		expect(existsSync(to)).toBe(false);
	});
	it("rejects oversized and checksum-mismatched responses", async () => {
		const to = join(directory(), "download");
		await expect(
			downloadToolAsset("https://example.com/tool", to, {
				maxBytes: 3,
				fetch: async () => new Response("large"),
			}),
		).rejects.toThrow("size limit");
		await expect(
			downloadToolAsset("https://example.com/tool", to, {
				sha256: "0".repeat(64),
				fetch: async () => new Response("complete"),
			}),
		).rejects.toThrow("checksum");
		expect(existsSync(to)).toBe(false);
	});
});

describe("installTool", () => {
	it("publishes once for concurrent installers and validates warm cache without download", async () => {
		const to = join(directory(), "fixture");
		let downloads = 0;
		const options = installOptions(to, async () => {
			downloads += 1;
			await Bun.sleep(50);
			return new Response(executable);
		});
		expect(
			await Promise.all([installTool(options), installTool(options)]),
		).toEqual([to, to]);
		expect(downloads).toBe(1);
		expect(isInstalledTool(to)).toBe(true);
		await installTool(options);
		expect(downloads).toBe(1);
	});
	it("keeps an existing executable intact when its replacement fails", async () => {
		const to = join(directory(), "fixture");
		writeFileSync(to, "#!/bin/sh\necho 'fixture version 0.1.0'\n");
		chmodSync(to, 0o755);
		const before = readFileSync(to, "utf8");
		await expect(
			installTool(
				installOptions(
					to,
					async () => new Response("offline", { status: 500 }),
				),
			),
		).rejects.toThrow("HTTP 500");
		expect(readFileSync(to, "utf8")).toBe(before);
	});
	it("replaces corrupt cache only after verifying a complete executable", async () => {
		const to = join(directory(), "fixture");
		const options = installOptions(to, async () => new Response(executable));
		await installTool(options);
		writeFileSync(to, "<html>bad download</html>");
		expect(isInstalledTool(to)).toBe(false);
		await installTool(options);
		expect(isInstalledTool(to)).toBe(true);
		expect(readFileSync(to, "utf8")).toBe(executable);
	});
	it("adopts a working older cache without downloading", async () => {
		const to = join(directory(), "fixture");
		writeFileSync(to, executable);
		chmodSync(to, 0o755);
		await installTool(
			installOptions(to, async () => {
				throw new Error("must not download");
			}),
		);
		expect(isInstalledTool(to)).toBe(true);
	});
	it("extracts one named archive entry in a private directory with shell-sensitive paths", async () => {
		const root = directory();
		const source = join(root, "fixture");
		writeFileSync(source, executable);
		const archive = join(root, "payload.tgz");
		execFileSync("tar", ["-czf", archive, "-C", root, "fixture"]);
		const to = join(root, "installed ' $; fixture");
		await installTool({
			...installOptions(to, async () => new Response(readFileSync(archive))),
			archiveEntry: "fixture",
		});
		expect(isInstalledTool(to)).toBe(true);
		expect(
			readdirSync(root).filter((name) => name.startsWith(".installed")),
		).toEqual([]);
	});
	it("extracts nested bottle binaries without retaining archive directories", async () => {
		const root = directory();
		mkdirSync(join(root, "bottle/1.2.3/bin"), { recursive: true });
		writeFileSync(join(root, "bottle/1.2.3/bin/fixture"), executable);
		const archive = join(root, "payload.tgz");
		execFileSync("tar", ["-czf", archive, "-C", root, "bottle"]);
		const to = join(root, "installed");
		await installTool({
			...installOptions(to, async () => new Response(readFileSync(archive))),
			archiveEntry: "bottle/1.2.3/bin/fixture",
		});
		expect(isInstalledTool(to)).toBe(true);
		expect(readFileSync(to, "utf8")).toBe(executable);
	});
	it("rejects archive member traversal and absolute paths", async () => {
		for (const archiveEntry of [
			"../fixture",
			"/fixture",
			"nested/../../fixture",
			"nested/./fixture",
			"nested\\fixture",
		]) {
			const to = join(directory(), "installed");
			await expect(
				installTool({
					...installOptions(to, async () => new Response("unused archive")),
					archiveEntry,
				}),
			).rejects.toThrow("relative path without traversal");
			expect(existsSync(to)).toBe(false);
		}
	});
	it("verifies GitHub asset digests when release metadata provides one", async () => {
		const to = join(directory(), "fixture");
		const digest = createHash("sha256").update(executable).digest("hex");
		const fetcher: ToolFetch = async (url) =>
			url.includes("api.github.com")
				? Response.json({
						assets: [{ name: "fixture", digest: `sha256:${digest}` }],
					})
				: new Response(executable);
		await installTool({
			...installOptions(to, fetcher),
			githubAsset: {
				repository: "example/tool",
				version: "v1",
				name: "fixture",
			},
		});
		expect(isInstalledTool(to)).toBe(true);
	});
});
