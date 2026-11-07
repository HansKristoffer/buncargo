import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	certificateShortfall,
	linuxTrustAnchorPath,
	verifyCertFailureTrust,
} from "./mkcert";

describe("certificateShortfall", () => {
	const now = Date.parse("2026-10-17T00:00:00Z");
	const day = 24 * 60 * 60 * 1000;
	const leaf = (names: string[], validTo = now + 365 * day) => ({
		names: new Set(names),
		validTo,
	});

	it("is satisfied by a covering certificate far from expiry", () => {
		expect(
			certificateShortfall(
				leaf(["*.app.localhost"]),
				["web.app.localhost"],
				now,
			),
		).toBeUndefined();
	});

	it("lists only the hostnames the certificate lacks", () => {
		expect(
			certificateShortfall(
				leaf(["web.app.localhost"]),
				["web.app.localhost", "api.other.localhost"],
				now,
			),
		).toEqual({ kind: "uncovered", hostnames: ["api.other.localhost"] });
	});

	it("reports expiry inside the renewal window separately", () => {
		const validTo = now + 5 * day;
		expect(
			certificateShortfall(
				leaf(["web.app.localhost"], validTo),
				["web.app.localhost"],
				now,
			),
		).toEqual({ kind: "expiring", validTo });
	});
});

describe("linuxTrustAnchorPath", () => {
	// Where `mkcert -install` copies the CA: what says it is still trusted
	// once `mkcert -uninstall` has removed it and left rootCA.pem behind.
	it("names mkcert's file in the first anchor directory the system has", () => {
		const debian = linuxTrustAnchorPath(
			"12345",
			(dir) => dir === "/usr/local/share/ca-certificates",
		);
		expect(debian).toBe(
			"/usr/local/share/ca-certificates/mkcert_development_CA_12345.crt",
		);
		const fedora = linuxTrustAnchorPath("12345", () => true);
		expect(fedora).toBe(
			"/etc/pki/ca-trust/source/anchors/mkcert_development_CA_12345.pem",
		);
	});

	it("cannot tell when the system has none of them", () => {
		expect(linuxTrustAnchorPath("12345", () => false)).toBeUndefined();
	});
});

describe("verifyCertFailureTrust", () => {
	function failureOf(run: () => void): unknown {
		try {
			run();
		} catch (error) {
			return error;
		}
		throw new Error("expected the command to fail");
	}

	// A `security verify-cert` stuck on the keychain is no answer, and calling
	// it untrusted would send every run to localhost:port.
	it("reads a check that timed out as unknown", () => {
		const timedOut = failureOf(() =>
			execFileSync("sleep", ["5"], { stdio: "ignore", timeout: 50 }),
		);
		expect(verifyCertFailureTrust(timedOut)).toBe("unknown");
	});

	it("reads a missing binary as unknown and a refusal as untrusted", () => {
		const missing = failureOf(() =>
			execFileSync("buncargo-no-such-binary", [], { stdio: "ignore" }),
		);
		const refused = failureOf(() =>
			execFileSync("false", [], { stdio: "ignore" }),
		);
		expect(verifyCertFailureTrust(missing)).toBe("unknown");
		expect(verifyCertFailureTrust(refused)).toBe("untrusted");
	});
});
