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
