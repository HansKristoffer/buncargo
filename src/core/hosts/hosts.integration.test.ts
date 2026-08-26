/**
 * Real mkcert mint (same folder as the hosts modules). Requires network on first
 * run if mkcert is not on PATH; may download the pinned binary into the temp cache.
 *
 * Opt-in: default `bun test` stays offline-friendly. Set `BUNCARGO_TEST_HOSTS=1`
 * or run `bun run test:integration-hosts`. Tests that need sudo, system trust,
 * or a bind on :443 are not included here.
 */

import { describe, expect, it } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMkcert, mintCert } from "./mkcert";

const runHostsIntegration =
	process.env.BUNCARGO_TEST_HOSTS === "1" ||
	process.env.BUNCARGO_TEST_HOSTS === "true";

describe.skipIf(!runHostsIntegration)("hosts mkcert integration", () => {
	it("resolves mkcert and mints a leaf covering every hostname", async () => {
		const previousCaroot = process.env.CAROOT;
		const caroot = mkdtempSync(join(tmpdir(), "buncargo-hosts-caroot-"));
		process.env.CAROOT = caroot;
		try {
			const mkcert = await ensureMkcert();
			expect(mkcert.length).toBeGreaterThan(0);

			const certPath = join(caroot, "leaf.pem");
			const keyPath = join(caroot, "leaf-key.pem");
			const minted = mintCert(
				["api.serpier.localhost", "web.serpier.localhost"],
				{ mkcertPath: mkcert, certPath, keyPath },
			);
			expect(minted.minted).toBe(true);

			const pem = await Bun.file(certPath).text();
			const cert = new X509Certificate(pem);
			expect(cert.checkHost("api.serpier.localhost")).toBeTruthy();
			expect(cert.checkHost("web.serpier.localhost")).toBeTruthy();
		} finally {
			if (previousCaroot === undefined) delete process.env.CAROOT;
			else process.env.CAROOT = previousCaroot;
			rmSync(caroot, { recursive: true, force: true });
		}
	});
});
