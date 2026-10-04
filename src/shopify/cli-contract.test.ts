import { describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutputCaptureScanner } from "../core/process/output-capture";
import { SHOPIFY_CAPTURES } from "./index";

/**
 * What buncargo relies on inside Shopify CLI, checked against real releases.
 *
 * A Shopify login is not available in CI, so this reads each release's bundle
 * for the contract instead of running `app dev`: the web schema's fixed
 * `port`, the fallback to every `shopify.web.toml` that makes
 * `web_directories` necessary, `--tunnel-url`, and the lines `captures`
 * match. Opt-in (downloads the CLI): `BUNCARGO_TEST_SHOPIFY_CLI=1`.
 */
const VERSIONS = ["3.93.1", "4.8.2"];
const enabled = process.env.BUNCARGO_TEST_SHOPIFY_CLI === "1";

function bundle(version: string): string {
	const dir = mkdtempSync(join(tmpdir(), `buncargo-shopify-cli-${version}-`));
	try {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
		const install = Bun.spawnSync(["bun", "add", `@shopify/cli@${version}`], {
			cwd: dir,
			stdout: "ignore",
			stderr: "pipe",
		});
		if (install.exitCode !== 0) throw new Error(install.stderr.toString());
		const dist = join(dir, "node_modules/@shopify/cli/dist");
		return readdirSync(dist)
			.filter((file) => file.endsWith(".js"))
			.map((file) => readFileSync(join(dist, file), "utf8"))
			.join("\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The captures, against output the way the CLI's TUI draws it under a
 * pseudo-terminal (the TUI gives it one): framed, redrawn in place, URLs
 * behind OSC 8 links whose text is a label. Always runs.
 */
describe("Shopify captures under a terminal", () => {
	it("read the URLs from a framed, redrawn TUI with hyperlinks", () => {
		const link = (url: string, text: string) =>
			`\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
		const frame = (n: number) =>
			[
				`\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G`,
				`╭─ info ──────────────╮\r\n`,
				`│ Using URL: \u001b[36mhttps://tunnel-${n}.trycloudflare.com\u001b[39m │\r\n`,
				`│ Preview URL: ${link("https://admin.shopify.com/store/s/apps/x?dev=1", "Open")} │\r\n`,
				`│ GraphiQL URL (Admin API): ${link("http://localhost:3457/graphiql?key=k", "localhost:3457…")} │\r\n`,
				`╰──────────────────────╯\r\n`,
				`\u001b[2m(p) Preview in your browser · (g) GraphiQL · (q) Quit\u001b[22m`,
			].join("");
		const scanner = createOutputCaptureScanner(SHOPIFY_CAPTURES);
		const raw = `${frame(1)}${frame(1)}\r\n✅ Ready, watching for changes in your app\r\n`;
		const found = [];
		// As a pseudo-terminal delivers it: in arbitrary chunks.
		for (let index = 0; index < raw.length; index += 37)
			found.push(...scanner.push(raw.slice(index, index + 37)));
		expect(
			Object.fromEntries(found.map((entry) => [entry.name, entry.value])),
		).toEqual({
			appUrl: "https://tunnel-1.trycloudflare.com",
			previewUrl: "https://admin.shopify.com/store/s/apps/x?dev=1",
			graphiqlUrl: "http://localhost:3457/graphiql?key=k",
			shopifyReady: expect.any(String),
		});
		// Each value once, though the frame was drawn twice.
		expect(found.filter((entry) => entry.name === "previewUrl")).toHaveLength(
			1,
		);
	});
});

/**
 * The same, in a pane narrower than the tunnel URL: Ink wraps the dev
 * session's log lines itself, with hard newlines and the time and source
 * columns repeated as padding, so the URL arrives in pieces. Always runs.
 */
describe("Shopify captures in a narrow pane", () => {
	const TUNNEL =
		"https://manufacturing-analytical-specifications-hamburg.trycloudflare.com";
	const dim = (text: string) => `\u001b[2m${text}\u001b[22m`;
	const raw = [
		`${dim("12:34:56")} │ \u001b[33mapp-preferences\u001b[39m │ Using URL: https://manufacturing-analyt\r\n`,
		`         │                 │ ical-specifications-hamburg.trycloudflare\r\n`,
		`         │                 │ .com\r\n`,
		`${dim("12:34:56")} │ \u001b[33mapp-proxy\u001b[39m       │ Using URL: https://manufacturing-analytica\r\n`,
		`         │                 │ l-specifications-hamburg.trycloudflare.com/api/\r\n`,
		`         │                 │ proxy\r\n`,
		// The footer redrawn in place.
		`\u001b[2K\u001b[1A\u001b[2K\u001b[G${dim("(p) Preview in your browser · (q) Quit")}`,
		`\u001b[2K\u001b[1A\u001b[2K\u001b[G✅ Ready, watching for changes in your app\r\n`,
	].join("");

	for (const size of [1, 7, 37, raw.length]) {
		it(`reads the whole tunnel URL in ${size}-byte chunks, and nothing cut off`, () => {
			const scanner = createOutputCaptureScanner(SHOPIFY_CAPTURES);
			const found = [];
			for (let index = 0; index < raw.length; index += size)
				found.push(...scanner.push(raw.slice(index, index + size)));
			expect(
				found
					.filter((entry) => entry.name === "appUrl")
					.map((entry) => entry.value),
			).toEqual([TUNNEL]);
			expect(found.some((entry) => entry.name === "shopifyReady")).toBe(true);
		});
	}
});

describe.skipIf(!enabled)("Shopify CLI contract", () => {
	for (const version of VERSIONS) {
		it(`holds for ${version}`, () => {
			const source = bundle(version);
			expect(source).toMatch(/port:\w+\.number\(\)\.max\(65536\)/);
			expect(source).toContain('"**/shopify.web.toml"');
			expect(source).toContain("tunnel-url");
			expect(source).toContain("Using URL: ${");
			expect(source).toContain("Ready, watching for changes in your app");
			expect(source).toContain("Preview URL: ");
			expect(source).toMatch(/GraphiQL URL( \(Admin API\))?: /);
			// Links are OSC 8 hyperlinks under a terminal: the captures read their
			// targets (see the pty test beside this one).
			expect(source).toContain("\\x1B]8;;");

			// And the patterns match lines rendered the way the CLI renders them.
			expect(
				SHOPIFY_CAPTURES.appUrl?.pattern.exec(
					"Using URL: https://a.trycloudflare.com",
				)?.[1],
			).toBe("https://a.trycloudflare.com");
			expect(
				SHOPIFY_CAPTURES.graphiqlUrl?.pattern.exec(
					"GraphiQL URL (Admin API): http://localhost:3457/graphiql?key=x",
				)?.[1],
			).toBe("http://localhost:3457/graphiql?key=x");
		}, 180_000);
	}
});
